import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';

import { HUB_PEOPLE_PATH, HUB_UPDATE_PATH } from '../../shared/hubProtocol.ts';
import { checkPersonName } from '../../shared/peopleTypes.ts';
import type { AppUpdateStatus, Person, PersonWithPassword, ResetPasswordResult } from '../../shared/peopleTypes.ts';
import type { LoginSessions } from '../auth/LoginSessions.ts';
import type { GroupMembersStore, InstanceManager, PeopleStore, PersonRecord } from '../contract.ts';
import { generatePassword, hashPassword } from '../passwords.ts';
import type { AppUpdateRequests } from './AppUpdateRequests.ts';
import { addGroupRoutes } from './createGroupRoutes.ts';
import { addressOf, authorizeOwner } from './instanceAuth.ts';

interface CreateAdminRoutesOptions {
    people: PeopleStore;
    instances: InstanceManager;
    sessions: Pick<LoginSessions, 'deletePerson'>;
    domain: string;
    secure: boolean;
    // Without it the update routes answer that this install has no update service.
    updates?: AppUpdateRequests | undefined;
    // Without it the group routes are not served.
    members?: GroupMembersStore | undefined;
}

interface ErrorResponse {
    error: string;
}

interface UnknownRecord {
    [key: string]: unknown;
}

const UNAUTHORIZED_MESSAGE = 'Owner authentication is required.';
const NOT_FOUND_MESSAGE = 'Person not found.';
const NAME_TAKEN_MESSAGE = 'That name is taken.';
const UPDATE_UNAVAILABLE: AppUpdateStatus = { state: 'unavailable' };

function authorize(context: Context, people: PeopleStore): PersonRecord | undefined {
    return authorizeOwner(context, people);
}

// A shared group is kept in the people store, but it is not a person: the people routes do not see it.
function findPerson(people: PeopleStore, name: string): PersonRecord | undefined {
    const record = people.find(name);

    return record?.role === 'group' ? undefined : record;
}

function errorResponse(context: Context, message: string, status: 400 | 401 | 404 | 409 | 500): Response {
    const body: ErrorResponse = { error: message };

    return context.json(body, status);
}

function personAddress(name: string, options: CreateAdminRoutesOptions): string {
    return addressOf(name, options.domain, options.secure);
}

async function toPerson(record: PersonRecord, options: CreateAdminRoutesOptions): Promise<Person> {
    const instanceStatus = await options.instances.status(record.name);
    const person: Person = {
        name: record.name,
        role: record.role,
        state: record.state,
        instance: instanceStatus,
        address: personAddress(record.name, options),
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
    };

    return person;
}

function readObject(value: unknown): UnknownRecord | undefined {
    const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);

    return isObject ? value as UnknownRecord : undefined;
}

async function readPersonName(context: Context): Promise<string | undefined> {
    const bodyText = await context.req.text()
        .catch(() => undefined);

    if (bodyText === undefined) {
        return undefined;
    }

    let body: unknown;

    try {
        body = JSON.parse(bodyText) as unknown;
    } catch {
        return undefined;
    }

    const record = readObject(body);
    const name = record?.name;

    return typeof name === 'string' ? name : undefined;
}

async function addPerson(context: Context, options: CreateAdminRoutesOptions): Promise<Response> {
    const owner = authorize(context, options.people);

    if (owner === undefined) {
        return errorResponse(context, UNAUTHORIZED_MESSAGE, 401);
    }

    const name = await readPersonName(context);

    if (name === undefined) {
        return errorResponse(context, 'A person name is required.', 400);
    }

    const nameError = checkPersonName(name);

    if (nameError !== undefined) {
        return errorResponse(context, nameError, 400);
    }

    if (options.people.find(name) !== undefined) {
        return errorResponse(context, NAME_TAKEN_MESSAGE, 409);
    }

    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    const secretBytes = randomBytes(32);
    const instanceSecret = secretBytes.toString('base64url');
    const record: PersonRecord = {
        name,
        role: 'member',
        state: 'active',
        passwordHash,
        mustChangePassword: true,
        instanceSecret,
        createdAt: Date.now(),
        lastSeenAt: null,
    };

    try {
        options.people.add(record);
    } catch (error: unknown) {
        if (options.people.find(name) !== undefined) {
            return errorResponse(context, NAME_TAKEN_MESSAGE, 409);
        }

        throw error;
    }

    try {
        await options.instances.create(record);
    } catch (error: unknown) {
        options.people.remove(name);

        throw error;
    }

    const person = await toPerson(record, options);
    const answer: PersonWithPassword = { person, password };

    return context.json(answer, 201);
}

async function changePersonState(context: Context, options: CreateAdminRoutesOptions, state: 'active' | 'inactive'): Promise<Response> {
    const owner = authorize(context, options.people);

    if (owner === undefined) {
        return errorResponse(context, UNAUTHORIZED_MESSAGE, 401);
    }

    const name = context.req.param('name');

    if (name === undefined) {
        return errorResponse(context, NOT_FOUND_MESSAGE, 404);
    }

    const person = findPerson(options.people, name);

    if (person === undefined) {
        return errorResponse(context, NOT_FOUND_MESSAGE, 404);
    }

    options.people.update(name, { state });

    if (state === 'inactive') {
        await options.instances.stop(name);
    }

    const updatedRecord = options.people.find(name);

    if (updatedRecord === undefined) {
        return errorResponse(context, NOT_FOUND_MESSAGE, 404);
    }

    const updatedPerson = await toPerson(updatedRecord, options);

    return context.json(updatedPerson);
}

async function resetPersonPassword(context: Context, options: CreateAdminRoutesOptions): Promise<Response> {
    const owner = authorize(context, options.people);

    if (owner === undefined) {
        return errorResponse(context, UNAUTHORIZED_MESSAGE, 401);
    }

    const name = context.req.param('name');

    if (name === undefined) {
        return errorResponse(context, NOT_FOUND_MESSAGE, 404);
    }

    const person = findPerson(options.people, name);

    if (person === undefined) {
        return errorResponse(context, NOT_FOUND_MESSAGE, 404);
    }

    const password = generatePassword();
    const passwordHash = await hashPassword(password);

    options.people.update(name, { passwordHash, mustChangePassword: true });

    // An owner who resets their own password keeps this session, since the new password shows on that page. The forced
    // change that follows ends every other session.
    if (name !== owner.name) {
        options.sessions.deletePerson(name);
    }

    const answer: ResetPasswordResult = { password };

    return context.json(answer);
}

async function removePerson(context: Context, options: CreateAdminRoutesOptions): Promise<Response> {
    const owner = authorize(context, options.people);

    if (owner === undefined) {
        return errorResponse(context, UNAUTHORIZED_MESSAGE, 401);
    }

    const name = context.req.param('name');

    if (name === undefined) {
        return errorResponse(context, NOT_FOUND_MESSAGE, 404);
    }

    if (context.req.query('confirm') !== name) {
        return errorResponse(context, 'Confirmation must match the person name.', 400);
    }

    const person = findPerson(options.people, name);

    if (person === undefined) {
        return errorResponse(context, NOT_FOUND_MESSAGE, 404);
    }

    if (person.role === 'owner') {
        return errorResponse(context, 'The owner cannot be removed.', 409);
    }

    const ownsGroup = options.members?.groupsOf(name)
        .some(group => group.role === 'owner') === true;

    if (ownsGroup) {
        return errorResponse(context, 'This person owns a shared group. Delete the group first.', 409);
    }

    await options.instances.remove(name);
    options.people.remove(name);
    options.sessions.deletePerson(name);

    return context.body(null, 204);
}

function createAdminRoutes(options: CreateAdminRoutesOptions): Hono {
    const app = new Hono();

    app.get(HUB_PEOPLE_PATH, async (context) => {
        const owner = authorize(context, options.people);

        if (owner === undefined) {
            return errorResponse(context, UNAUTHORIZED_MESSAGE, 401);
        }

        const records = options.people.list()
            .filter(record => record.role !== 'group');
        const personRequests = records.map(record => toPerson(record, options));
        const people = await Promise.all(personRequests);

        return context.json(people);
    });
    app.get(HUB_UPDATE_PATH, (context) => {
        if (authorize(context, options.people) === undefined) {
            return errorResponse(context, UNAUTHORIZED_MESSAGE, 401);
        }

        const status = options.updates?.status() ?? UPDATE_UNAVAILABLE;

        return context.json(status);
    });
    app.post(HUB_UPDATE_PATH, (context) => {
        if (authorize(context, options.people) === undefined) {
            return errorResponse(context, UNAUTHORIZED_MESSAGE, 401);
        }

        const status = options.updates?.start();

        if (status === undefined) {
            return errorResponse(context, 'An update is running, or this install cannot update from the web app.', 409);
        }

        return context.json(status);
    });
    app.post(HUB_PEOPLE_PATH, context => addPerson(context, options));
    app.post(`${HUB_PEOPLE_PATH}/:name/deactivate`, context => changePersonState(context, options, 'inactive'));
    app.post(`${HUB_PEOPLE_PATH}/:name/reactivate`, context => changePersonState(context, options, 'active'));
    app.post(`${HUB_PEOPLE_PATH}/:name/reset-password`, context => resetPersonPassword(context, options));
    app.delete(`${HUB_PEOPLE_PATH}/:name`, context => removePerson(context, options));
    if (options.members !== undefined) {
        addGroupRoutes(app, { ...options, members: options.members });
    }

    app.notFound(context => errorResponse(context, NOT_FOUND_MESSAGE, 404));
    app.onError((_error, context) => errorResponse(context, 'The hub could not complete the request.', 500));

    return app;
}

export { createAdminRoutes };
export type { CreateAdminRoutesOptions };
