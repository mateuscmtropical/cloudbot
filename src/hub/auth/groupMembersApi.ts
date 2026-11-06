import type { Context } from 'hono';

import type { GroupMember, GroupRole } from '../../shared/peopleTypes.ts';
import type { GroupMembersStore, PeopleStore } from '../contract.ts';

interface GroupMembersApiOptions {
    people: PeopleStore;
    members: GroupMembersStore;
    groupName: string;
    actingName: string;
    actingRole: GroupRole;
}

// What the members panel of a group shows. Only an admin or the owner gets the people they can add.
interface GroupMembersView {
    you: GroupMember;
    members: GroupMember[];
    canManage: boolean;
    addable: string[];
}

interface GroupMembersError {
    error: string;
}

interface UnknownRecord {
    [key: string]: unknown;
}

const GROUP_MEMBERS_PATH = '/__hub/members';
const SETTABLE_ROLES: readonly GroupRole[] = ['admin', 'member'];

function canManage(role: GroupRole): boolean {
    return role === 'owner' || role === 'admin';
}

function buildView(options: GroupMembersApiOptions): GroupMembersView {
    const members = options.members.list(options.groupName);
    const memberNameList = members.map(member => member.name);
    const memberNames = new Set(memberNameList);
    const isManager = canManage(options.actingRole);
    const people = isManager ? options.people.list() : [];
    const addable = people
        .filter(person => person.role !== 'group' && person.state === 'active' && !memberNames.has(person.name))
        .map(person => person.name);

    return { you: { name: options.actingName, role: options.actingRole }, members, canManage: isManager, addable };
}

function readField(body: unknown, field: string): string | undefined {
    const isObject = typeof body === 'object' && body !== null && !Array.isArray(body);
    const value = isObject ? (body as UnknownRecord)[field] : undefined;

    return typeof value === 'string' ? value : undefined;
}

function refuse(context: Context, message: string, status: 400 | 403 | 404 | 409): Response {
    const body: GroupMembersError = { error: message };

    return context.json(body, status);
}

// An admin or the owner adds people, removes them and sets their role. Nobody changes or removes the owner of the group.
async function changeMember(context: Context, options: GroupMembersApiOptions): Promise<Response> {
    if (!canManage(options.actingRole)) {
        return refuse(context, 'Only an admin or the owner of this group can change its members.', 403);
    }

    const body: unknown = await context.req.json()
        .catch(() => undefined);
    const action = readField(body, 'action');
    const personName = readField(body, 'person') ?? '';
    const person = options.people.find(personName);

    if (person === undefined || person.role === 'group') {
        return refuse(context, 'Person not found.', 404);
    }

    if (options.members.roleOf(options.groupName, person.name) === 'owner') {
        return refuse(context, 'The owner of the group keeps that role and cannot be removed.', 409);
    }

    if (action === 'remove') {
        options.members.remove(options.groupName, person.name);

        const afterRemove = buildView(options);

        return context.json(afterRemove);
    }

    const role = readField(body, 'role');
    const chosenRole = SETTABLE_ROLES.find(candidate => candidate === role);

    if (action !== 'set' || chosenRole === undefined || person.state !== 'active') {
        return refuse(context, 'Send action set with the role admin or member, or action remove.', 400);
    }

    const now = Date.now();

    options.members.set(options.groupName, person.name, chosenRole, now);

    const afterSet = buildView(options);

    return context.json(afterSet);
}

async function serveGroupMembers(context: Context, options: GroupMembersApiOptions): Promise<Response> {
    if (context.req.method === 'GET') {
        const view = buildView(options);

        return context.json(view);
    }

    return context.req.method === 'POST' ? changeMember(context, options) : refuse(context, 'Use GET or POST.', 400);
}

export { GROUP_MEMBERS_PATH, serveGroupMembers };
export type { GroupMembersView };
