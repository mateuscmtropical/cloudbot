import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ACTING_PERSON_HEADER, ACTING_ROLE_HEADER, HUB_GROUPS_PATH, HUB_MY_GROUPS_PATH, HUB_PEOPLE_PATH, INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../shared/hubProtocol.ts';
import type { InstanceStatus, MyGroup, Person, SharedGroup } from '../shared/peopleTypes.ts';
import { createAdminRoutes } from './admin/createAdminRoutes.ts';
import { createFrontDoorRoutes } from './auth/createFrontDoorRoutes.ts';
import { GroupEntryTickets } from './auth/groupAccess.ts';
import { createLoginSessionTables, SqliteLoginSessions } from './auth/LoginSessions.ts';
import { hubSessionCookieName } from './auth/sessionCookie.ts';
import type { ActivityTracker, InstanceManager, PersonRecord, StartResult } from './contract.ts';
import { openHubDatabase } from './store/openHubDatabase.ts';
import { createGroupMemberTables, SqliteGroupMembers } from './store/SqliteGroupMembers.ts';
import { SqlitePeopleStore } from './store/SqlitePeopleStore.ts';

interface SeenRequest {
    acting: string;
    role: string;
}

const DOMAIN = 'example.test';
const SESSION_COOKIE = hubSessionCookieName(false);

class RunningInstances implements InstanceManager {
    status(): Promise<InstanceStatus> {
        return Promise.resolve('running');
    }

    create(): Promise<void> {
        return Promise.resolve();
    }

    start(): Promise<StartResult> {
        return Promise.resolve('running');
    }

    stop(): Promise<void> {
        return Promise.resolve();
    }

    remove(): Promise<void> {
        return Promise.resolve();
    }
}

const NO_ACTIVITY: ActivityTracker = { touch: () => undefined, opened: () => undefined, closed: () => undefined };

function makePerson(name: string, role: 'owner' | 'member'): PersonRecord {
    return { name, role, state: 'active', passwordHash: 'x', mustChangePassword: false, instanceSecret: `${name}-secret`, createdAt: 0, lastSeenAt: null };
}

function readHeader(request: IncomingMessage, name: string): string {
    const value = request.headers[name];

    return typeof value === 'string' ? value : '';
}

describe('shared groups in the hub', () => {
    let upstream: Server;
    let upstreamPort: number;
    let seen: SeenRequest[];

    beforeEach(async () => {
        seen = [];
        upstream = createServer((request, response) => {
            seen.push({ acting: readHeader(request, ACTING_PERSON_HEADER), role: readHeader(request, ACTING_ROLE_HEADER) });
            response.end('ok');
        });
        await new Promise<void>((resolve) => {
            upstream.listen(0, '127.0.0.1', resolve);
        });

        const address = upstream.address();

        upstreamPort = address !== null && typeof address === 'object' ? address.port : 0;
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => {
            upstream.close(() => {
                resolve();
            });
        });
    });

    function createHub(): { request: (path: string, init?: RequestInit) => Promise<Response>; sessions: SqliteLoginSessions; members: SqliteGroupMembers } {
        const database = openHubDatabase(':memory:');
        const people = new SqlitePeopleStore(database);

        createLoginSessionTables(database);
        createGroupMemberTables(database);
        people.add(makePerson('owner', 'owner'));
        people.add(makePerson('maria', 'member'));
        people.add(makePerson('joao', 'member'));

        const sessions = new SqliteLoginSessions(database);
        const members = new SqliteGroupMembers(database);
        const instances = new RunningInstances();
        const admin = createAdminRoutes({ people, instances, sessions, domain: DOMAIN, secure: false, members });
        const frontDoor = createFrontDoorRoutes({
            people,
            instances,
            sessions,
            domain: DOMAIN,
            secure: false,
            activity: NO_ACTIVITY,
            members,
            entryTickets: new GroupEntryTickets(),
            upstreamFor: () => ({ hostname: '127.0.0.1', port: upstreamPort }),
        });
        const request = async (path: string, init?: RequestInit): Promise<Response> => {
            const app = path.startsWith('/internal') ? admin : frontDoor;

            return app.request(path, init);
        };

        return { request, sessions, members };
    }

    function asInstance(name: string, method = 'GET', body?: unknown): RequestInit {
        const headers: Record<string, string> = { [INSTANCE_NAME_HEADER]: name, [INSTANCE_SECRET_HEADER]: `${name}-secret` };

        if (body === undefined) {
            return { method, headers };
        }

        return { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) };
    }

    function onHost(host: string, cookie?: string, extra: Record<string, string> = {}): RequestInit {
        const cookieHeader: Record<string, string> = cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` };

        return { headers: { host: `${host}.${DOMAIN}`, ...cookieHeader, ...extra } };
    }

    it('makes a group owned by the caller, keeps it out of the people list, and shows it to its members', async () => {
        const hub = createHub();
        const created = await hub.request(HUB_GROUPS_PATH, asInstance('owner', 'POST', { name: 'team' }));
        const group = await created.json() as SharedGroup;

        expect(created.status)
            .toBe(201);
        expect(group.members)
            .toEqual([{ name: 'owner', role: 'owner' }]);

        await hub.request(`${HUB_GROUPS_PATH}/team/members/maria`, asInstance('owner', 'PUT', { role: 'member' }));

        const peopleAnswer = await hub.request(HUB_PEOPLE_PATH, asInstance('owner'));
        const people = await peopleAnswer.json() as Person[];
        const mariaGroupsAnswer = await hub.request(HUB_MY_GROUPS_PATH, asInstance('maria'));
        const mariaGroups = await mariaGroupsAnswer.json() as MyGroup[];
        const joaoGroupsAnswer = await hub.request(HUB_MY_GROUPS_PATH, asInstance('joao'));

        expect(people.map(person => person.name))
            .toEqual(['joao', 'maria', 'owner']);
        expect(mariaGroups)
            .toEqual([{ name: 'team', openPath: '/__hub/groups/team/open', role: 'member' }]);
        expect(await joaoGroupsAnswer.json())
            .toEqual([]);
    });

    it('keeps the owner of a group, and lets only the server owner manage groups', async () => {
        const hub = createHub();

        await hub.request(HUB_GROUPS_PATH, asInstance('owner', 'POST', { name: 'team' }));

        const demote = await hub.request(`${HUB_GROUPS_PATH}/team/members/owner`, asInstance('owner', 'PUT', { role: 'member' }));
        const removeOwner = await hub.request(`${HUB_GROUPS_PATH}/team/members/owner`, asInstance('owner', 'DELETE'));
        const byMember = await hub.request(HUB_GROUPS_PATH, asInstance('maria', 'POST', { name: 'other' }));
        const resetGroup = await hub.request(`${HUB_PEOPLE_PATH}/team/reset-password`, asInstance('owner', 'POST'));

        expect(demote.status)
            .toBe(409);
        expect(removeOwner.status)
            .toBe(409);
        expect(byMember.status)
            .toBe(401);
        expect(resetGroup.status)
            .toBe(404);
    });

    it('lets a member in with a one-time ticket, and tells the instance who acts', async () => {
        const hub = createHub();

        await hub.request(HUB_GROUPS_PATH, asInstance('owner', 'POST', { name: 'team' }));
        await hub.request(`${HUB_GROUPS_PATH}/team/members/maria`, asInstance('owner', 'PUT', { role: 'admin' }));

        const mariaSession = hub.sessions.create('maria', Date.now());
        const opened = await hub.request('/__hub/groups/team/open', onHost('maria', mariaSession));
        const enterUrl = new URL(opened.headers.get('location') ?? '');

        expect(opened.status)
            .toBe(303);
        expect(enterUrl.host)
            .toBe(`team.${DOMAIN}`);

        const entered = await hub.request(`${enterUrl.pathname}${enterUrl.search}`, onHost('team'));
        const setCookie = entered.headers.get('set-cookie') ?? '';
        const cookiePattern = new RegExp(`${SESSION_COOKIE}=([^;]+)`);
        const groupSession = cookiePattern.exec(setCookie)?.[1];
        const reused = await hub.request(`${enterUrl.pathname}${enterUrl.search}`, onHost('team'));

        expect(entered.status)
            .toBe(303);
        expect(groupSession)
            .toBeDefined();
        expect(reused.status)
            .toBe(401);

        const page = await hub.request('/', onHost('team', groupSession, { [ACTING_PERSON_HEADER]: 'owner', [ACTING_ROLE_HEADER]: 'owner' }));

        expect(await page.text())
            .toBe('ok');
        expect(seen)
            .toEqual([{ acting: 'maria', role: 'admin' }]);
    });

    it('keeps out people who are not in the group', async () => {
        const hub = createHub();

        await hub.request(HUB_GROUPS_PATH, asInstance('owner', 'POST', { name: 'team' }));

        const joaoSession = hub.sessions.create('joao', Date.now());
        const opened = await hub.request('/__hub/groups/team/open', onHost('joao', joaoSession));
        const withPersonSession = await hub.request('/', onHost('team', joaoSession));
        const withoutSession = await hub.request('/', onHost('team'));

        expect(opened.status)
            .toBe(404);
        expect(withPersonSession.status)
            .toBe(401);
        expect(withoutSession.status)
            .toBe(401);
        expect(seen)
            .toEqual([]);
    });

    it('lets an admin manage members but never the owner, and lets a member only look', async () => {
        const hub = createHub();

        await hub.request(HUB_GROUPS_PATH, asInstance('owner', 'POST', { name: 'team' }));
        await hub.request(`${HUB_GROUPS_PATH}/team/members/maria`, asInstance('owner', 'PUT', { role: 'admin' }));

        const mariaSession = hub.sessions.create('maria', Date.now());
        const asMaria = (body: unknown): RequestInit => ({
            method: 'POST',
            headers: { 'host': `team.${DOMAIN}`, 'cookie': `${SESSION_COOKIE}=${mariaSession}`, 'origin': `http://team.${DOMAIN}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        const added = await hub.request('/__hub/members', asMaria({ action: 'set', person: 'joao', role: 'member' }));
        const removeOwner = await hub.request('/__hub/members', asMaria({ action: 'remove', person: 'owner' }));
        const addedView = await added.json() as { members: { name: string }[] };

        expect(added.status)
            .toBe(200);
        expect(addedView.members.map(member => member.name))
            .toContain('joao');
        expect(removeOwner.status)
            .toBe(409);

        const joaoSession = hub.sessions.create('joao', Date.now());
        const joaoView = await hub.request('/__hub/members', onHost('team', joaoSession));
        const joaoChange = await hub.request('/__hub/members', {
            method: 'POST',
            headers: { 'host': `team.${DOMAIN}`, 'cookie': `${SESSION_COOKIE}=${joaoSession}`, 'origin': `http://team.${DOMAIN}`, 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'remove', person: 'maria' }),
        });

        expect(await joaoView.json())
            .toMatchObject({ you: { name: 'joao', role: 'member' }, canManage: false, addable: [] });
        expect(joaoChange.status)
            .toBe(403);
        expect(seen)
            .toEqual([]);
    });
});
