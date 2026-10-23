import { HUB_ACTIVITY_PATH, HUB_TRUST_HEADER } from '../../shared/hubProtocol.ts';
import type { InstanceActivity } from '../../shared/hubProtocol.ts';
import type { ActivityTracker, InstanceManager, PeopleStore, PersonRecord } from '../contract.ts';

interface IdleWatcherOptions {
    people: PeopleStore;
    instances: InstanceManager;
    fetchActivity: (name: string, secret: string) => Promise<InstanceActivity>;
    idleMs?: number;
    checkEveryMs?: number;
    now?: () => number;
    log?: (message: string) => void;
}

interface FetchActivityOptions {
    fetch: typeof fetch;
    instanceUrl: (name: string) => string;
}

interface PersonActivityState {
    lastTouchAt: number;
    openConnections: number;
}

interface UnknownRecord {
    [key: string]: unknown;
}

type FetchActivity = (name: string, secret: string) => Promise<InstanceActivity>;

const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_CHECK_EVERY_MS = 30 * 1000;
const MINUTE_MS = 60 * 1000;

function configuredIdleMs(): number {
    const configuredMinutes = Number(process.env.CLOUDBOT_IDLE_MINUTES);

    return Number.isFinite(configuredMinutes) && configuredMinutes > 0
        ? configuredMinutes * MINUTE_MS
        : DEFAULT_IDLE_MS;
}

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === 'object' && value !== null;
}

function readInstanceActivity(value: unknown): InstanceActivity {
    if (!isRecord(value) || typeof value.isBusy !== 'boolean' || !Array.isArray(value.reasons)) {
        throw new Error('The instance answered with invalid activity data.');
    }

    const reasons = value.reasons;
    const textReasons = reasons.filter((reason): reason is string => typeof reason === 'string');

    if (textReasons.length !== reasons.length) {
        throw new Error('The instance answered with invalid activity data.');
    }

    return { isBusy: value.isBusy, reasons: textReasons };
}

function createFetchActivity(options: FetchActivityOptions): FetchActivity {
    return async (name, secret) => {
        const configuredInstanceUrl = options.instanceUrl(name);
        const instanceBaseUrl = configuredInstanceUrl.replace(/\/+$/, '');
        const activityUrl = `${instanceBaseUrl}${HUB_ACTIVITY_PATH}`;
        const request: RequestInit = {
            method: 'GET',
            headers: { [HUB_TRUST_HEADER]: secret },
        };
        const response = await options.fetch(activityUrl, request);

        if (!response.ok) {
            throw new Error(`The instance answered ${String(response.status)}.`);
        }

        const body: unknown = await response.json();

        return readInstanceActivity(body);
    };
}

class IdleWatcher implements ActivityTracker {
    private readonly people: PeopleStore;
    private readonly instances: InstanceManager;
    private readonly fetchActivity: FetchActivity;
    private readonly idleMs: number;
    private readonly checkEveryMs: number;
    private readonly now: () => number;
    private readonly log: (message: string) => void;
    private readonly activity = new Map<string, PersonActivityState>();
    private readonly lastSeenUpdates = new Map<string, number>();
    private readonly lastFailureLogs = new Map<string, number>();
    private timer: NodeJS.Timeout | undefined;
    private lifecycle = 0;
    private isTicking = false;

    constructor(options: IdleWatcherOptions) {
        this.people = options.people;
        this.instances = options.instances;
        this.fetchActivity = options.fetchActivity;
        this.idleMs = options.idleMs ?? configuredIdleMs();
        this.checkEveryMs = options.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS;
        this.now = options.now ?? (() => Date.now());
        this.log = options.log ?? ((message) => {
            console.error(message);
        });
    }

    start(): void {
        if (this.timer !== undefined) {
            return;
        }

        const startedAt = this.now();

        this.lifecycle += 1;
        this.people.list()
            .forEach((person) => {
                this.ensureActivity(person.name, startedAt);
            });

        this.timer = setInterval(() => {
            void this.checkIdleInstances();
        }, this.checkEveryMs);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }

        this.lifecycle += 1;
    }

    touch(name: string): void {
        const touchedAt = this.now();
        const previous = this.activity.get(name);

        this.activity.set(name, {
            lastTouchAt: touchedAt,
            openConnections: previous?.openConnections ?? 0,
        });

        const storedPerson = this.people.find(name);
        const lastUpdateAt = this.lastSeenUpdates.get(name) ?? storedPerson?.lastSeenAt ?? undefined;
        const canUpdateLastSeen = lastUpdateAt === undefined || touchedAt - lastUpdateAt >= MINUTE_MS;

        if (canUpdateLastSeen) {
            this.people.update(name, { lastSeenAt: touchedAt });
            this.lastSeenUpdates.set(name, touchedAt);
        }
    }

    opened(name: string): void {
        const currentTime = this.now();
        const state = this.ensureActivity(name, currentTime);

        state.openConnections += 1;
    }

    closed(name: string): void {
        const currentTime = this.now();
        const state = this.ensureActivity(name, currentTime);

        state.openConnections = Math.max(0, state.openConnections - 1);
    }

    private ensureActivity(name: string, fallbackTime: number): PersonActivityState {
        const existing = this.activity.get(name);

        if (existing !== undefined) {
            return existing;
        }

        const state: PersonActivityState = {
            lastTouchAt: fallbackTime,
            openConnections: 0,
        };

        this.activity.set(name, state);

        return state;
    }

    private async checkIdleInstances(): Promise<void> {
        if (this.timer === undefined || this.isTicking) {
            return;
        }

        const lifecycle = this.lifecycle;

        this.isTicking = true;

        try {
            const people = this.people.list();

            this.removeMissingPeople(people);

            const checks = people.map(person => this.checkPerson(person, lifecycle));

            await Promise.all(checks);
        } finally {
            this.isTicking = false;
        }
    }

    private removeMissingPeople(people: PersonRecord[]): void {
        const currentNameList = people.map(person => person.name);
        const currentNames = new Set(currentNameList);

        this.activity.forEach((_state, name) => {
            if (!currentNames.has(name)) {
                this.activity.delete(name);
                this.lastSeenUpdates.delete(name);
                this.lastFailureLogs.delete(name);
            }
        });
    }

    private async checkPerson(person: PersonRecord, lifecycle: number): Promise<void> {
        const initialTime = this.now();
        const initialState = this.ensureActivity(person.name, initialTime);

        if (initialState.openConnections > 0 || this.now() - initialState.lastTouchAt < this.idleMs) {
            return;
        }

        let status: string;

        try {
            status = await this.instances.status(person.name);
        } catch {
            this.logFailure(person.name, 'Could not check instance status');

            return;
        }

        if (status !== 'running' || lifecycle !== this.lifecycle) {
            return;
        }

        const stateBeforeFetch = this.activity.get(person.name);

        if (stateBeforeFetch === undefined || stateBeforeFetch.openConnections > 0 || this.now() - stateBeforeFetch.lastTouchAt < this.idleMs) {
            return;
        }

        let instanceActivity: InstanceActivity;

        try {
            instanceActivity = await this.fetchActivity(person.name, person.instanceSecret);
        } catch {
            this.logFailure(person.name, 'Could not fetch instance activity');

            return;
        }

        if (lifecycle !== this.lifecycle) {
            return;
        }

        const currentState = this.activity.get(person.name);

        if (currentState === undefined || currentState.openConnections > 0 || this.now() - currentState.lastTouchAt < this.idleMs) {
            return;
        }

        if (instanceActivity.isBusy) {
            currentState.lastTouchAt = this.now();

            return;
        }

        try {
            await this.instances.stop(person.name);
        } catch {
            this.logFailure(person.name, 'Could not stop idle instance');
        }
    }

    private logFailure(name: string, message: string): void {
        const currentTime = this.now();
        const previousLog = this.lastFailureLogs.get(name);

        if (previousLog === undefined || currentTime - previousLog >= MINUTE_MS) {
            this.log(`${message} for ${name}.`);
            this.lastFailureLogs.set(name, currentTime);
        }
    }
}

function createIdleWatcher(options: IdleWatcherOptions): IdleWatcher {
    return new IdleWatcher(options);
}

export { createFetchActivity, createIdleWatcher, IdleWatcher };
export type { FetchActivityOptions, IdleWatcherOptions };
