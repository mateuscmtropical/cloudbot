import type { AppUpdateStatus, GroupMember, GroupRole, Person, PersonWithPassword, ResetPasswordResult } from '../shared/peopleTypes.ts';
import { RequestFailedError } from './apiClient.ts';

interface ErrorResponseBody {
    error?: unknown;
}

interface AddPersonPayload {
    name: string;
}

interface DeletePersonPayload {
    confirm: string;
}

async function readServerMessage(response: Response): Promise<string | undefined> {
    try {
        const body = await response.json() as ErrorResponseBody;

        return typeof body.error === 'string' ? body.error : undefined;
    } catch {
        return undefined;
    }
}

async function requestPeople(path: string, init: RequestInit, expectedStatus: number): Promise<Response> {
    const response = await fetch(path, init);

    if (response.status !== expectedStatus) {
        const serverMessage = await readServerMessage(response);

        throw new RequestFailedError(path, response.status, serverMessage);
    }

    return response;
}

async function requestPeopleJson<ResponseBody>(path: string, init: RequestInit, expectedStatus: number): Promise<ResponseBody> {
    const response = await requestPeople(path, init, expectedStatus);
    const body = await response.json() as ResponseBody;

    return body;
}

function personPath(name: string, action: string): string {
    const encodedName = encodeURIComponent(name);

    return `/api/people/${encodedName}/${action}`;
}

function jsonRequest(method: string, payload: unknown): RequestInit {
    const body = JSON.stringify(payload);
    const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' }, body };

    return init;
}

// How this CloudBot relates to a hub. A CloudBot that runs on its own is standalone. A shared group is group.
type HubRole = 'standalone' | 'member' | 'owner' | 'group';

interface HubContext {
    role: HubRole;
    personName?: string;
    // In a shared group: who is using it and their role there.
    actingName?: string;
    groupRole?: GroupRole;
}

// What the hub shows about the members of a shared group.
interface GroupMembersView {
    you: GroupMember;
    members: GroupMember[];
    canManage: boolean;
    addable: string[];
}

interface ChangeGroupMemberPayload {
    action: 'set' | 'remove';
    person: string;
    role?: 'admin' | 'member';
}

// Served by the hub on the group's address, not by this CloudBot.
const GROUP_MEMBERS_PATH = '/__hub/members';

async function getHubContext(): Promise<HubContext> {
    return requestPeopleJson<HubContext>('/api/hub-role', { method: 'GET' }, 200);
}

async function getHubRole(): Promise<HubRole> {
    const context = await getHubContext();

    return context.role;
}

function listPeople(): Promise<Person[]> {
    return requestPeopleJson<Person[]>('/api/people', { method: 'GET' }, 200);
}

function addPerson(name: string): Promise<PersonWithPassword> {
    const payload: AddPersonPayload = { name };
    const init = jsonRequest('POST', payload);

    return requestPeopleJson<PersonWithPassword>('/api/people', init, 201);
}

function deactivatePerson(name: string): Promise<Person> {
    const path = personPath(name, 'deactivate');
    const init = jsonRequest('POST', {});

    return requestPeopleJson<Person>(path, init, 200);
}

function reactivatePerson(name: string): Promise<Person> {
    const path = personPath(name, 'reactivate');
    const init = jsonRequest('POST', {});

    return requestPeopleJson<Person>(path, init, 200);
}

function resetPersonPassword(name: string): Promise<ResetPasswordResult> {
    const path = personPath(name, 'reset-password');
    const init = jsonRequest('POST', {});

    return requestPeopleJson<ResetPasswordResult>(path, init, 200);
}

async function deletePerson(name: string): Promise<void> {
    const path = `/api/people/${encodeURIComponent(name)}`;
    const payload: DeletePersonPayload = { confirm: name };
    const init = jsonRequest('DELETE', payload);

    await requestPeople(path, init, 204);
}

function getAppUpdate(): Promise<AppUpdateStatus> {
    return requestPeopleJson<AppUpdateStatus>('/api/update', { method: 'GET' }, 200);
}

function startAppUpdate(): Promise<AppUpdateStatus> {
    const init = jsonRequest('POST', {});

    return requestPeopleJson<AppUpdateStatus>('/api/update', init, 200);
}

function getGroupMembers(): Promise<GroupMembersView> {
    return requestPeopleJson<GroupMembersView>(GROUP_MEMBERS_PATH, { method: 'GET' }, 200);
}

function changeGroupMember(payload: ChangeGroupMemberPayload): Promise<GroupMembersView> {
    const init = jsonRequest('POST', payload);

    return requestPeopleJson<GroupMembersView>(GROUP_MEMBERS_PATH, init, 200);
}

export { getAppUpdate, startAppUpdate, addPerson, changeGroupMember, deactivatePerson, deletePerson, getGroupMembers, getHubContext, getHubRole, listPeople, reactivatePerson, resetPersonPassword };
export type { ChangeGroupMemberPayload, GroupMembersView, HubContext, HubRole };
