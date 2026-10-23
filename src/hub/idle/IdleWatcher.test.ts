import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstanceManager, PeopleStore, PersonRecord, PersonUpdate } from '../contract.ts';
import { createFetchActivity, createIdleWatcher } from './IdleWatcher.ts';

interface FixtureOptions {
    fetchActivity?: (name: string, secret: string) => Promise<{ isBusy: boolean; reasons: string[] }>;
    idleMs?: number;
    checkEveryMs?: number;
    log?: (message: string) => void;
}

interface IdleWatcherFixture {
    watcher: ReturnType<typeof createIdleWatcher>;
    person: PersonRecord;
    people: PeopleStore;
    instances: InstanceManager;
    fetchActivityCalls: string[];
    logs: string[];
    stoppedNames: string[];
}

function createPerson(name: string, lastSeenAt: number | null = null): PersonRecord {
    return {
        name,
        role: 'member',
        state: 'active',
        passwordHash: 'password-hash',
        mustChangePassword: false,
        instanceSecret: `secret-${name}`,
        createdAt: 0,
        lastSeenAt,
    };
}

function createFixture(options: FixtureOptions = {}): IdleWatcherFixture {
    const person = createPerson('ana');
    const records = new Map([[person.name, person]]);
    const people: PeopleStore = {
        list: () => [...records.values()],
        find: name => records.get(name),
        add: record => records.set(record.name, record),
        update: (name, update: PersonUpdate) => {
            const current = records.get(name);

            if (current !== undefined) {
                records.set(name, { ...current, ...update });
            }
        },
        remove: name => records.delete(name),
    };
    const stoppedNames: string[] = [];
    const instances: InstanceManager = {
        status: () => Promise.resolve('running'),
        create: () => Promise.resolve(),
        start: () => Promise.resolve('running'),
        stop: (name) => {
            stoppedNames.push(name);

            return Promise.resolve();
        },
        remove: () => Promise.resolve(),
    };
    const fetchActivityCalls: string[] = [];
    const fetchActivity = async (name: string, secret: string): Promise<{ isBusy: boolean; reasons: string[] }> => {
        fetchActivityCalls.push(`${name}:${secret}`);

        return options.fetchActivity === undefined
            ? { isBusy: false, reasons: [] }
            : options.fetchActivity(name, secret);
    };
    const logs: string[] = [];
    const watcher = createIdleWatcher({
        people,
        instances,
        fetchActivity,
        idleMs: options.idleMs ?? 200,
        checkEveryMs: options.checkEveryMs ?? 100,
        now: () => Date.now(),
        log: options.log ?? (message => logs.push(message)),
    });

    return { watcher, person, people, instances, fetchActivityCalls, logs, stoppedNames };
}

async function advanceBy(milliseconds: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(milliseconds);
}

afterEach(() => {
    vi.useRealTimers();
});

describe('IdleWatcher', () => {
    it('stops an idle running instance after checking its activity', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const fixture = createFixture();

        fixture.watcher.start();
        await advanceBy(100);
        expect(fixture.stoppedNames)
            .toEqual([]);
        await advanceBy(100);

        expect(fixture.fetchActivityCalls)
            .toEqual(['ana:secret-ana']);
        expect(fixture.stoppedNames)
            .toEqual(['ana']);

        fixture.watcher.stop();
    });

    it('keeps an instance awake while a stream is open', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const fixture = createFixture();

        fixture.watcher.start();
        fixture.watcher.touch('ana');
        fixture.watcher.opened('ana');
        await advanceBy(1000);

        expect(fixture.fetchActivityCalls)
            .toEqual([]);
        expect(fixture.stoppedNames)
            .toEqual([]);

        fixture.watcher.closed('ana');
        fixture.watcher.stop();
    });

    it('waits another idle period when the instance reports a running turn', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const fixture = createFixture({ fetchActivity: () => Promise.resolve({ isBusy: true, reasons: ['turn running or queued'] }) });

        fixture.watcher.start();
        await advanceBy(200);
        expect(fixture.fetchActivityCalls)
            .toHaveLength(1);
        await advanceBy(100);
        expect(fixture.fetchActivityCalls)
            .toHaveLength(1);
        await advanceBy(100);

        expect(fixture.fetchActivityCalls)
            .toHaveLength(2);
        expect(fixture.stoppedNames)
            .toEqual([]);

        fixture.watcher.stop();
    });

    it('keeps an instance awake and rate limits activity fetch failures in logs', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const fixture = createFixture({
            idleMs: 100,
            checkEveryMs: 1000,
            fetchActivity: () => Promise.reject(new Error('secret must not be logged')),
        });

        fixture.watcher.start();
        await advanceBy(1000);
        await advanceBy(59_000);

        expect(fixture.stoppedNames)
            .toEqual([]);
        expect(fixture.logs)
            .toEqual(['Could not fetch instance activity for ana.']);

        fixture.watcher.stop();
    });

    it('does not count connection closes below zero', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const fixture = createFixture();

        fixture.watcher.start();
        fixture.watcher.closed('ana');
        fixture.watcher.opened('ana');
        await advanceBy(1000);

        expect(fixture.fetchActivityCalls)
            .toEqual([]);
        expect(fixture.stoppedNames)
            .toEqual([]);

        fixture.watcher.closed('ana');
        fixture.watcher.stop();
    });

    it('updates the stored last seen time no more than once per minute', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const fixture = createFixture();

        fixture.watcher.touch('ana');
        expect(fixture.people.find('ana')?.lastSeenAt)
            .toBe(0);

        vi.setSystemTime(30_000);
        fixture.watcher.touch('ana');
        expect(fixture.people.find('ana')?.lastSeenAt)
            .toBe(0);

        vi.setSystemTime(60_000);
        fixture.watcher.touch('ana');
        expect(fixture.people.find('ana')?.lastSeenAt)
            .toBe(60_000);
    });

    it('starts with each unseen person used at the hub start time', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const fixture = createFixture({ idleMs: 500 });

        fixture.watcher.start();
        vi.setSystemTime(1100);
        await advanceBy(100);

        expect(fixture.fetchActivityCalls)
            .toEqual([]);

        fixture.watcher.stop();
    });
});

describe('createFetchActivity', () => {
    it('sends the trusted hub header and validates an activity answer', async () => {
        let requestedUrl = '';
        let trustedHeader: string | null = null;
        const fetchFunction: typeof fetch = (input, init) => {
            requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            const headers = new Headers(init?.headers);

            trustedHeader = headers.get('x-cloudbot-hub');

            return Promise.resolve(new Response(JSON.stringify({ isBusy: false, reasons: [] }), { status: 200 }));
        };
        const fetchActivity = createFetchActivity({ fetch: fetchFunction, instanceUrl: name => `http://${name}.internal/` });

        await expect(fetchActivity('ana', 'secret-ana'))
            .resolves
            .toEqual({ isBusy: false, reasons: [] });
        expect(requestedUrl)
            .toBe('http://ana.internal/api/hub/activity');
        expect(trustedHeader)
            .toBe('secret-ana');
    });

    it('rejects invalid activity answers', async () => {
        const fetchFunction: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ isBusy: 'no', reasons: [] }), { status: 200 }));
        const fetchActivity = createFetchActivity({ fetch: fetchFunction, instanceUrl: () => 'http://ana.internal' });

        await expect(fetchActivity('ana', 'secret-ana'))
            .rejects
            .toThrow('invalid activity data');
    });
});
