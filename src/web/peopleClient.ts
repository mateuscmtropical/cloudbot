import type { AppUpdateStatus, GroupMember, GroupRole, MyGroup, Person, PersonWithPassword, ResetPasswordResult, SentBotResult, SharedGroup } from '../shared/peopleTypes.ts';
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

function groupPath(group: string, rest: string): string {
    const encodedGroup = encodeURIComponent(group);

    return `/api/groups/${encodedGroup}${rest}`;
}

function listGroups(): Promise<SharedGroup[]> {
    return requestPeopleJson<SharedGroup[]>('/api/groups', { method: 'GET' }, 200);
}

function addGroup(name: string): Promise<SharedGroup> {
    const init = jsonRequest('POST', { name });

    return requestPeopleJson<SharedGroup>('/api/groups', init, 201);
}

function setGroupMemberRole(group: string, person: string, role: 'admin' | 'member'): Promise<SharedGroup> {
    const encodedPerson = encodeURIComponent(person);
    const path = groupPath(group, `/members/${encodedPerson}`);
    const init = jsonRequest('PUT', { role });

    return requestPeopleJson<SharedGroup>(path, init, 200);
}

// Copy keeps the bot here too. Move removes it here once the group has it.
function sendBotToGroup(group: string, botId: string, mode: 'copy' | 'move'): Promise<SentBotResult> {
    const path = groupPath(group, '/bots');
    const init = jsonRequest('POST', { botId, mode });

    return requestPeopleJson<SentBotResult>(path, init, 201);
}

// Deletes a shared group with its instance. The name is typed again to confirm.
async function deleteGroup(name: string): Promise<void> {
    const path = groupPath(name, `?confirm=${encodeURIComponent(name)}`);

    await requestPeople(path, { method: 'DELETE' }, 204);
}

// The shared groups this person is in. Each opens through the hub on this address.
function listMyGroups(): Promise<MyGroup[]> {
    return requestPeopleJson<MyGroup[]>('/api/my-groups', { method: 'GET' }, 200);
}

export { getAppUpdate, startAppUpdate, addGroup, addPerson, changeGroupMember, deactivatePerson, deleteGroup, deletePerson, getGroupMembers, getHubContext, getHubRole, listGroups, listMyGroups, listPeople, reactivatePerson, resetPersonPassword, sendBotToGroup, setGroupMemberRole };
export type { ChangeGroupMemberPayload, GroupMembersView, HubContext, HubRole };
