import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';

import { HUB_PEOPLE_PATH, INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../../shared/hubProtocol.ts';
import { checkPersonName } from '../../shared/peopleTypes.ts';
import type { Person, PersonWithPassword, ResetPasswordResult } from '../../shared/peopleTypes.ts';
import type { InstanceManager, PeopleStore, PersonRecord } from '../contract.ts';
import { generatePassword, hashPassword } from '../passwords.ts';

interface CreateAdminRoutesOptions {
    people: PeopleStore;
    instances: InstanceManager;
    domain: string;
    secure: boolean;
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

function hasMatchingSecret(candidate: string, expected: string): boolean {
    const candidateDigest = createHash('sha256')
        .update(candidate)
        .digest();
    const expectedDigest = createHash('sha256')
        .update(expected)
        .digest();

    return timingSafeEqual(candidateDigest, expectedDigest);
}

function authorize(context: Context, people: PeopleStore): PersonRecord | undefined {
    const instanceName = context.req.header(INSTANCE_NAME_HEADER);
    const instanceSecret = context.req.header(INSTANCE_SECRET_HEADER);

    if (instanceName === undefined || instanceSecret === undefined) {
        return undefined;
    }

    const person = people.find(instanceName);

    if (person === undefined || person.role !== 'owner' || !hasMatchingSecret(instanceSecret, person.instanceSecret)) {
        return undefined;
    }

    return person;
}

function errorResponse(context: Context, message: string, status: 400 | 401 | 404 | 409 | 500): Response {
    const body: ErrorResponse = { error: message };

    return context.json(body, status);
}

function personAddress(name: string, options: CreateAdminRoutesOptions): string {
    if (options.domain === 'localhost') {
        return `http://${name}.localhost`;
    }

    const scheme = options.secure ? 'https' : 'http';

    return `${scheme}://${name}.${options.domain}`;
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

    const person = options.people.find(name);

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

    const person = options.people.find(name);

    if (person === undefined) {
        return errorResponse(context, NOT_FOUND_MESSAGE, 404);
    }

    const password = generatePassword();
    const passwordHash = await hashPassword(password);

    options.people.update(name, { passwordHash, mustChangePassword: true });
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

    const person = options.people.find(name);

    if (person === undefined) {
        return errorResponse(context, NOT_FOUND_MESSAGE, 404);
    }

    if (person.role === 'owner') {
        return errorResponse(context, 'The owner cannot be removed.', 409);
    }

    await options.instances.remove(name);
    options.people.remove(name);

    return context.body(null, 204);
}

function createAdminRoutes(options: CreateAdminRoutesOptions): Hono {
    const app = new Hono();

    app.get(HUB_PEOPLE_PATH, async (context) => {
        const owner = authorize(context, options.people);

        if (owner === undefined) {
            return errorResponse(context, UNAUTHORIZED_MESSAGE, 401);
        }

        const records = options.people.list();
        const personRequests = records.map(record => toPerson(record, options));
        const people = await Promise.all(personRequests);

        return context.json(people);
    });
    app.post(HUB_PEOPLE_PATH, context => addPerson(context, options));
    app.post(`${HUB_PEOPLE_PATH}/:name/deactivate`, context => changePersonState(context, options, 'inactive'));
    app.post(`${HUB_PEOPLE_PATH}/:name/reactivate`, context => changePersonState(context, options, 'active'));
    app.post(`${HUB_PEOPLE_PATH}/:name/reset-password`, context => resetPersonPassword(context, options));
    app.delete(`${HUB_PEOPLE_PATH}/:name`, context => removePerson(context, options));
    app.notFound(context => errorResponse(context, NOT_FOUND_MESSAGE, 404));
    app.onError((_error, context) => errorResponse(context, 'The hub could not complete the request.', 500));

    return app;
}

export { createAdminRoutes };
export type { CreateAdminRoutesOptions };
