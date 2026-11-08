import { describe, expect, it, vi } from 'vitest';

import { HUB_MY_USAGE_PATH, HUB_USAGE_PATH, INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../../shared/hubProtocol.ts';
import type { HostUsage, InstanceUsage } from '../../shared/usageTypes.ts';
import type { PeopleStore, PersonRecord } from '../contract.ts';
import { createUsageRoutes } from './createUsageRoutes.ts';

function makeRecord(name: string, role: PersonRecord['role'], state: PersonRecord['state'] = 'active'): PersonRecord {
    return { name, role, state, passwordHash: 'hash', mustChangePassword: false, instanceSecret: `${name}-secret`, createdAt: 1, lastSeenAt: null };
}

const OWNER = makeRecord('owner', 'owner');
const MARIA = makeRecord('maria', 'member');
const JOAO = makeRecord('joao', 'member');
const GROUP = makeRecord('team', 'group');
const HOST: HostUsage = { cpuCount: 4, loadAverage: 1, memoryTotalBytes: 8, memoryUsedBytes: 4, diskTotalBytes: 100, diskUsedBytes: 50 };

function headersOf(record: PersonRecord, secret: string = record.instanceSecret): Record<string, string> {
    return { [INSTANCE_NAME_HEADER]: record.name, [INSTANCE_SECRET_HEADER]: secret };
}

function makeApp(records: PersonRecord[] = [OWNER, MARIA, JOAO, GROUP]): { app: ReturnType<typeof createUsageRoutes>; readInstance: ReturnType<typeof vi.fn>; readHost: ReturnType<typeof vi.fn> } {
    const people = {
        list: () => records,
        find: (name: string) => records.find(record => record.name === name),
    } as unknown as PeopleStore;
    const readInstance = vi.fn((record: Pick<PersonRecord, 'name' | 'role'>): Promise<InstanceUsage> => Promise.resolve({ name: record.name, role: record.role, instance: 'running', numbers: null }));
    const readHost = vi.fn(() => Promise.resolve(HOST));
    const app = createUsageRoutes({ people, usage: { readHost, readInstance } });

    return { app, readInstance, readHost };
}

describe('hub usage routes', () => {
    it('gives the owner the machine and every instance, shared groups included', async () => {
        const { app } = makeApp();

        const response = await app.request(HUB_USAGE_PATH, { headers: headersOf(OWNER) });
        const body = await response.json() as { host: HostUsage; instances: InstanceUsage[] };

        expect(response.status)
            .toBe(200);
        expect(body.host)
            .toEqual(HOST);
        expect(body.instances.map(instance => instance.name))
            .toEqual(['owner', 'maria', 'joao', 'team']);
    });

    it('never gives a member the machine or the other instances, and reads nothing for them', async () => {
        const { app, readInstance, readHost } = makeApp();

        const response = await app.request(HUB_USAGE_PATH, { headers: headersOf(MARIA) });

        expect(response.status)
            .toBe(401);
        expect(await response.text()).not.toContain('joao');
        expect(readInstance)
            .not.toHaveBeenCalled();
        expect(readHost)
            .not.toHaveBeenCalled();
    });

    it('refuses the owner name with a wrong secret, a missing header, an inactive owner and a group', async () => {
        const inactiveOwner = makeRecord('owner', 'owner', 'inactive');
        const requests = [
            { records: undefined, headers: headersOf(OWNER, 'guess') },
            { records: undefined, headers: {} },
            { records: undefined, headers: headersOf(GROUP) },
            { records: [inactiveOwner, MARIA], headers: headersOf(inactiveOwner) },
        ];

        const statuses = await Promise.all(requests.map(async (request) => {
            const { app } = makeApp(request.records);
            const response = await app.request(HUB_USAGE_PATH, { headers: request.headers });

            return response.status;
        }));

        expect(statuses)
            .toEqual([401, 401, 401, 401]);
    });

    it('gives each person only their own instance, picked by the secret and not by anything in the request', async () => {
        const { app, readInstance } = makeApp();

        const response = await app.request(`${HUB_MY_USAGE_PATH}?name=joao`, { headers: { ...headersOf(MARIA), 'x-cloudbot-person': 'joao' } });
        const body = await response.json() as InstanceUsage;

        expect(response.status)
            .toBe(200);
        expect(body.name)
            .toBe('maria');
        expect(readInstance)
            .toHaveBeenCalledOnce();
        expect(readInstance)
            .toHaveBeenCalledWith(expect.objectContaining({ name: 'maria' }));
    });

    it('lets the owner read their own instance there too, and refuses a wrong secret', async () => {
        const { app } = makeApp();

        const own = await app.request(HUB_MY_USAGE_PATH, { headers: headersOf(OWNER) });
        const forged = await app.request(HUB_MY_USAGE_PATH, { headers: headersOf(MARIA, 'owner-secret') });

        expect(own.status)
            .toBe(200);
        expect(forged.status)
            .toBe(401);
    });
});
