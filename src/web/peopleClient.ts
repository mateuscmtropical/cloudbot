import type { Person, PersonWithPassword, ResetPasswordResult } from '../shared/peopleTypes.ts';
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

// How this CloudBot relates to a hub. A CloudBot that runs on its own is standalone.
type HubRole = 'standalone' | 'member' | 'owner';

async function getHubRole(): Promise<HubRole> {
    const body = await requestPeopleJson<{ role: HubRole }>('/api/hub-role', { method: 'GET' }, 200);

    return body.role;
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

export { addPerson, deactivatePerson, deletePerson, getHubRole, listPeople, reactivatePerson, resetPersonPassword };
export type { HubRole };
