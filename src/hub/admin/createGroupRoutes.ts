import { randomBytes } from 'node:crypto';
import type { Context, Hono } from 'hono';

import { HUB_GROUPS_PATH, HUB_MY_GROUPS_PATH } from '../../shared/hubProtocol.ts';
import { checkPersonName } from '../../shared/peopleTypes.ts';
import type { GroupRole, MyGroup, SharedGroup } from '../../shared/peopleTypes.ts';
import type { GroupMembersStore, InstanceManager, PeopleStore, PersonRecord } from '../contract.ts';
import { addressOf, authorizeInstance, authorizeOwner } from './instanceAuth.ts';

interface GroupRoutesOptions {
    people: PeopleStore;
    instances: InstanceManager;
    members: GroupMembersStore;
    domain: string;
    secure: boolean;
}

interface GroupErrorResponse {
    error: string;
}

interface UnknownRecord {
    [key: string]: unknown;
}

const UNAUTHORIZED_MESSAGE = 'Owner authentication is required.';
const GROUP_NOT_FOUND_MESSAGE = 'Group not found.';
const PERSON_NOT_FOUND_MESSAGE = 'Person not found.';
const NAME_TAKEN_MESSAGE = 'That name is taken.';
const CHANGEABLE_ROLES: readonly GroupRole[] = ['admin', 'member'];

function groupError(context: Context, message: string, status: 400 | 401 | 404 | 409): Response {
    const body: GroupErrorResponse = { error: message };

    return context.json(body, status);
}

function findGroup(people: PeopleStore, name: string): PersonRecord | undefined {
    const record = people.find(name);

    return record?.role === 'group' ? record : undefined;
}

function findPerson(people: PeopleStore, name: string): PersonRecord | undefined {
    const record = people.find(name);

    return record === undefined || record.role === 'group' ? undefined : record;
}

async function toSharedGroup(record: PersonRecord, options: GroupRoutesOptions): Promise<SharedGroup> {
    const instance = await options.instances.status(record.name);

    return {
        name: record.name,
        address: addressOf(record.name, options.domain, options.secure),
        instance,
        members: options.members.list(record.name),
        createdAt: record.createdAt,
    };
}

async function readBodyField(context: Context, field: string): Promise<string | undefined> {
    const body: unknown = await context.req.json()
        .catch(() => undefined);
    const isObject = typeof body === 'object' && body !== null && !Array.isArray(body);
    const value = isObject ? (body as UnknownRecord)[field] : undefined;

    return typeof value === 'string' ? value : undefined;
}

// A group gets an instance like a person, with no password. Its members open it from their own address.
async function addGroup(context: Context, options: GroupRoutesOptions): Promise<Response> {
    const owner = authorizeOwner(context, options.people);

    if (owner === undefined) {
        return groupError(context, UNAUTHORIZED_MESSAGE, 401);
    }

    const name = await readBodyField(context, 'name');
    const nameError = name === undefined ? 'A group name is required.' : checkPersonName(name);

    if (name === undefined || nameError !== undefined) {
        return groupError(context, nameError ?? 'A group name is required.', 400);
    }

    if (options.people.find(name) !== undefined) {
        return groupError(context, NAME_TAKEN_MESSAGE, 409);
    }

    const secretBytes = randomBytes(32);
    const now = Date.now();
    const record: PersonRecord = {
        name,
        role: 'group',
        state: 'active',
        passwordHash: '',
        mustChangePassword: false,
        instanceSecret: secretBytes.toString('base64url'),
        createdAt: now,
        lastSeenAt: null,
    };

    options.people.add(record);

    try {
        await options.instances.create(record);
    } catch (error: unknown) {
        options.people.remove(name);

        throw error;
    }

    options.members.set(name, owner.name, 'owner', now);

    const group = await toSharedGroup(record, options);

    return context.json(group, 201);
}

async function setMember(context: Context, options: GroupRoutesOptions): Promise<Response> {
    if (authorizeOwner(context, options.people) === undefined) {
        return groupError(context, UNAUTHORIZED_MESSAGE, 401);
    }

    const group = findGroup(options.people, context.req.param('name') ?? '');
    const person = findPerson(options.people, context.req.param('person') ?? '');

    if (group === undefined) {
        return groupError(context, GROUP_NOT_FOUND_MESSAGE, 404);
    }

    if (person === undefined) {
        return groupError(context, PERSON_NOT_FOUND_MESSAGE, 404);
    }

    const role = await readBodyField(context, 'role');
    const chosenRole = CHANGEABLE_ROLES.find(candidate => candidate === role);

    if (chosenRole === undefined) {
        return groupError(context, 'The role must be admin or member.', 400);
    }

    if (options.members.roleOf(group.name, person.name) === 'owner') {
        return groupError(context, 'The owner of the group keeps that role.', 409);
    }

    const now = Date.now();

    options.members.set(group.name, person.name, chosenRole, now);

    const answer = await toSharedGroup(group, options);

    return context.json(answer);
}

async function removeMember(context: Context, options: GroupRoutesOptions): Promise<Response> {
    if (authorizeOwner(context, options.people) === undefined) {
        return groupError(context, UNAUTHORIZED_MESSAGE, 401);
    }

    const group = findGroup(options.people, context.req.param('name') ?? '');
    const personName = context.req.param('person') ?? '';

    if (group === undefined) {
        return groupError(context, GROUP_NOT_FOUND_MESSAGE, 404);
    }

    const role = options.members.roleOf(group.name, personName);

    if (role === undefined) {
        return groupError(context, PERSON_NOT_FOUND_MESSAGE, 404);
    }

    if (role === 'owner') {
        return groupError(context, 'The owner of the group cannot be removed.', 409);
    }

    options.members.remove(group.name, personName);

    const answer = await toSharedGroup(group, options);

    return context.json(answer);
}

async function removeGroup(context: Context, options: GroupRoutesOptions): Promise<Response> {
    if (authorizeOwner(context, options.people) === undefined) {
        return groupError(context, UNAUTHORIZED_MESSAGE, 401);
    }

    const name = context.req.param('name') ?? '';
    const group = findGroup(options.people, name);

    if (group === undefined) {
        return groupError(context, GROUP_NOT_FOUND_MESSAGE, 404);
    }

    if (context.req.query('confirm') !== name) {
        return groupError(context, 'Confirmation must match the group name.', 400);
    }

    await options.instances.remove(name);
    options.people.remove(name);

    return context.body(null, 204);
}

// The groups the calling person is in. Only active groups, since a stopped one cannot be opened.
function listMyGroups(context: Context, options: GroupRoutesOptions): Response {
    const person = authorizeInstance(context, options.people);

    if (person === undefined) {
        return groupError(context, 'Instance authentication is required.', 401);
    }

    const myGroups: MyGroup[] = options.members.groupsOf(person.name)
        .filter(group => findGroup(options.people, group.name)?.state === 'active')
        .map(group => ({ name: group.name, openPath: `/__hub/groups/${group.name}/open`, role: group.role }));

    return context.json(myGroups);
}

function addGroupRoutes(app: Hono, options: GroupRoutesOptions): void {
    app.get(HUB_GROUPS_PATH, async (context) => {
        if (authorizeOwner(context, options.people) === undefined) {
            return groupError(context, UNAUTHORIZED_MESSAGE, 401);
        }

        const groupRecords = options.people.list()
            .filter(record => record.role === 'group');
        const groupRequests = groupRecords.map(record => toSharedGroup(record, options));
        const groups = await Promise.all(groupRequests);

        return context.json(groups);
    });
    app.post(HUB_GROUPS_PATH, context => addGroup(context, options));
    app.put(`${HUB_GROUPS_PATH}/:name/members/:person`, context => setMember(context, options));
    app.delete(`${HUB_GROUPS_PATH}/:name/members/:person`, context => removeMember(context, options));
    app.delete(`${HUB_GROUPS_PATH}/:name`, context => removeGroup(context, options));
    app.get(HUB_MY_GROUPS_PATH, context => listMyGroups(context, options));
}

export { addGroupRoutes };
export type { GroupRoutesOptions };
