import { HUB_PEOPLE_PATH, INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../../shared/hubProtocol.ts';
import type { InstanceStatus, Person, PersonRole, PersonState, PersonWithPassword, ResetPasswordResult } from '../../shared/peopleTypes.ts';
import type { HubConfig } from './hubConfig.ts';
import { PeopleAdminError } from './PeopleAdmin.ts';
import type { PeopleAdmin } from './PeopleAdmin.ts';

type FetchFunction = typeof fetch;

const ROLES: readonly string[] = ['owner', 'member'];
const STATES: readonly string[] = ['active', 'inactive'];
const INSTANCE_STATUSES: readonly string[] = ['missing', 'stopped', 'starting', 'running'];
const NO_CONTENT = 204;
const BAD_GATEWAY = 502;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function unexpectedAnswer(): PeopleAdminError {
    return new PeopleAdminError('The hub answered with something unexpected.', BAD_GATEWAY);
}

function readPerson(value: unknown): Person {
    if (!isRecord(value)) {
        throw unexpectedAnswer();
    }

    const { name, role, state, instance, address, createdAt, lastSeenAt } = value;
    const hasValidText = typeof name === 'string' && typeof address === 'string';
    const hasValidChoices = typeof role === 'string' && ROLES.includes(role) && typeof state === 'string' && STATES.includes(state) && typeof instance === 'string' && INSTANCE_STATUSES.includes(instance);
    const hasValidTimes = typeof createdAt === 'number' && (lastSeenAt === null || typeof lastSeenAt === 'number');

    if (!hasValidText || !hasValidChoices || !hasValidTimes) {
        throw unexpectedAnswer();
    }

    return { name, role: role as PersonRole, state: state as PersonState, instance: instance as InstanceStatus, address, createdAt, lastSeenAt };
}

function readPassword(value: unknown): string {
    if (!isRecord(value) || typeof value.password !== 'string') {
        throw unexpectedAnswer();
    }

    return value.password;
}

// Calls the hub admin API from the owner's instance. The hub accepts these calls only from the owner's secret.
class HubClient implements PeopleAdmin {
    private readonly config: HubConfig;
    private readonly fetchFunction: FetchFunction;

    constructor(config: HubConfig, fetchFunction: FetchFunction = fetch) {
        this.config = config;
        this.fetchFunction = fetchFunction;
    }

    async list(): Promise<Person[]> {
        const answer = await this.request('GET', HUB_PEOPLE_PATH);

        if (!Array.isArray(answer)) {
            throw unexpectedAnswer();
        }

        return answer.map(readPerson);
    }

    async add(name: string): Promise<PersonWithPassword> {
        const answer = await this.request('POST', HUB_PEOPLE_PATH, { name });

        if (!isRecord(answer)) {
            throw unexpectedAnswer();
        }

        return { person: readPerson(answer.person), password: readPassword(answer) };
    }

    async deactivate(name: string): Promise<Person> {
        const path = this.personPath(name, 'deactivate');
        const answer = await this.request('POST', path);

        return readPerson(answer);
    }

    async reactivate(name: string): Promise<Person> {
        const path = this.personPath(name, 'reactivate');
        const answer = await this.request('POST', path);

        return readPerson(answer);
    }

    async resetPassword(name: string): Promise<ResetPasswordResult> {
        const path = this.personPath(name, 'reset-password');
        const answer = await this.request('POST', path);
        const password = readPassword(answer);

        return { password };
    }

    async remove(name: string): Promise<void> {
        const encodedName = encodeURIComponent(name);

        await this.request('DELETE', `${HUB_PEOPLE_PATH}/${encodedName}?confirm=${encodedName}`);
    }

    private personPath(name: string, action: string): string {
        const encodedName = encodeURIComponent(name);

        return `${HUB_PEOPLE_PATH}/${encodedName}/${action}`;
    }

    private async request(method: string, path: string, body?: object): Promise<unknown> {
        const headers: Record<string, string> = {
            [INSTANCE_NAME_HEADER]: this.config.personName,
            [INSTANCE_SECRET_HEADER]: this.config.secret,
        };

        if (body !== undefined) {
            headers['content-type'] = 'application/json';
        }

        const init: RequestInit = { method, headers };

        if (body !== undefined) {
            init.body = JSON.stringify(body);
        }

        const response = await this.fetchFunction(`${this.config.hubUrl}${path}`, init)
            .catch(() => {
                throw new PeopleAdminError('Could not reach the hub.', BAD_GATEWAY);
            });

        if (response.status === NO_CONTENT) {
            return undefined;
        }

        const answer: unknown = await response.json()
            .catch(() => undefined);

        if (!response.ok) {
            const message = isRecord(answer) && typeof answer.error === 'string' ? answer.error : `The hub answered ${String(response.status)}.`;

            throw new PeopleAdminError(message, response.status);
        }

        return answer;
    }
}

export { HubClient };
