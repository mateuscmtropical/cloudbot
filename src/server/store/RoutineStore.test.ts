import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';
import { RoutineStore } from './RoutineStore.ts';

const MINUTE_MS = 60 * 1000;
const EVERY_TEN_MINUTES = { kind: 'interval', everyMinutes: 10 } as const;

describe('RoutineStore', () => {
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let clock: number;
    let store: RoutineStore;
    let botId: string;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        clock = Date.UTC(2026, 9, 21, 11, 0);
        store = new RoutineStore(opened.db, { now: () => clock });

        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        botId = bot.id;
    });

    afterEach(() => {
        opened.close();
    });

    it('adds an enabled routine with its first run time', async () => {
        const routine = await store.add(botId, { name: 'Inbox', prompt: 'Check my inbox.', schedule: EVERY_TEN_MINUTES });

        expect(routine)
            .toMatchObject({ botId, name: 'Inbox', isEnabled: true, lastRunAt: null, nextRunAt: clock + 10 * MINUTE_MS });
        await expect(store.list(botId))
            .resolves.toEqual([routine]);
    });

    it('lists only routines that are enabled and due', async () => {
        const first = await store.add(botId, { name: 'A', prompt: 'a', schedule: EVERY_TEN_MINUTES });
        const second = await store.add(botId, { name: 'B', prompt: 'b', schedule: { kind: 'interval', everyMinutes: 20 } });

        await expect(store.listDue(clock + 9 * MINUTE_MS))
            .resolves.toEqual([]);
        await expect(store.listDue(clock + 25 * MINUTE_MS))
            .resolves.toEqual([first, second]);

        await store.setEnabled(botId, first.id, false);
        const dueAfterDisable = await store.listDue(clock + 25 * MINUTE_MS);

        expect(dueAfterDisable.map(routine => routine.id))
            .toEqual([second.id]);
    });

    it('moves the next run past now after a run', async () => {
        const routine = await store.add(botId, { name: 'A', prompt: 'a', schedule: EVERY_TEN_MINUTES });
        const lateMs = clock + 3 * 60 * MINUTE_MS;

        await store.markRun(routine, lateMs);

        const [updated] = await store.list(botId);

        expect(updated)
            .toMatchObject({ lastRunAt: lateMs, nextRunAt: lateMs + 10 * MINUTE_MS });
        await expect(store.listDue(lateMs))
            .resolves.toEqual([]);
    });

    it('starts the schedule from now when a routine is turned on again', async () => {
        const routine = await store.add(botId, { name: 'A', prompt: 'a', schedule: EVERY_TEN_MINUTES });

        await store.setEnabled(botId, routine.id, false);
        clock += 60 * MINUTE_MS;
        await store.setEnabled(botId, routine.id, true);

        const [updated] = await store.list(botId);

        expect(updated)
            .toMatchObject({ isEnabled: true, nextRunAt: clock + 10 * MINUTE_MS });
    });

    it('changes and removes a routine only for its own bot', async () => {
        const otherBot = await botStore.create({ name: 'Bia', title: 'Assistant', description: '' });
        const routine = await store.add(botId, { name: 'A', prompt: 'a', schedule: EVERY_TEN_MINUTES });

        await expect(store.setEnabled(otherBot.id, routine.id, false))
            .resolves.toBe(false);
        await expect(store.remove(otherBot.id, routine.id))
            .resolves.toBe(false);
        await expect(store.remove(botId, routine.id))
            .resolves.toBe(true);
        await expect(store.list(botId))
            .resolves.toEqual([]);
    });
});
