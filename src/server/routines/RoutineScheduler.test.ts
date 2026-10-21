import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { RoutineStore } from '../store/RoutineStore.ts';

import { CHECK_INTERVAL_MS, RoutineScheduler } from './RoutineScheduler.ts';

const MINUTE_MS = 60 * 1000;
const EVERY_TEN_MINUTES = { kind: 'interval', everyMinutes: 10 } as const;

describe('RoutineScheduler', () => {
    let opened: OpenedDatabase;
    let store: RoutineStore;
    let clock: number;
    let botId: string;
    let sent: [string, string][];
    let sendMessage: (botId: string, text: string) => Promise<unknown>;
    let scheduler: RoutineScheduler;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        clock = Date.UTC(2026, 9, 21, 11, 0);
        store = new RoutineStore(opened.db, { now: () => clock });

        const bot = await new BotStore(opened.db)
            .create({ name: 'Ana', title: 'Assistant', description: '' });

        botId = bot.id;
        sent = [];
        sendMessage = (targetBotId, text) => {
            sent.push([targetBotId, text]);

            return Promise.resolve();
        };
        scheduler = new RoutineScheduler({ routineStore: store, sendMessage, now: () => clock });
    });

    afterEach(() => {
        scheduler.stop();
        vi.useRealTimers();
        opened.close();
    });

    it('sends the prompt of a due routine to its bot', async () => {
        await store.add(botId, { name: 'Inbox', prompt: 'Check my inbox.', schedule: EVERY_TEN_MINUTES });
        clock += 10 * MINUTE_MS;
        await scheduler.checkDueRoutines();

        expect(sent)
            .toEqual([[botId, 'Routine "Inbox": Check my inbox.']]);
    });

    it('keeps a due routine for later while it is not ready', async () => {
        let isReady = false;
        const waitingScheduler = new RoutineScheduler({ routineStore: store, sendMessage, isReady: () => isReady, now: () => clock });

        await store.add(botId, { name: 'Inbox', prompt: 'Check.', schedule: EVERY_TEN_MINUTES });
        clock += 10 * MINUTE_MS;
        await waitingScheduler.checkDueRoutines();

        expect(sent)
            .toEqual([]);

        isReady = true;
        await waitingScheduler.checkDueRoutines();

        expect(sent)
            .toHaveLength(1);
    });

    it('sends nothing before the routine is due or when it is off', async () => {
        const routine = await store.add(botId, { name: 'Inbox', prompt: 'Check.', schedule: EVERY_TEN_MINUTES });

        clock += 9 * MINUTE_MS;
        await scheduler.checkDueRoutines();
        await store.setEnabled(botId, routine.id, false);
        clock += 60 * MINUTE_MS;
        await scheduler.checkDueRoutines();

        expect(sent)
            .toEqual([]);
    });

    it('runs a routine that was missed for hours once, not once per slot', async () => {
        await store.add(botId, { name: 'Inbox', prompt: 'Check.', schedule: EVERY_TEN_MINUTES });
        clock += 5 * 60 * MINUTE_MS;
        await scheduler.checkDueRoutines();
        await scheduler.checkDueRoutines();

        expect(sent)
            .toHaveLength(1);
    });

    it('does not repeat the run when the message cannot be sent', async () => {
        const failingScheduler = new RoutineScheduler({
            routineStore: store,
            sendMessage: () => Promise.reject(new Error('down')),
            now: () => clock,
        });
        const consoleError = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);

        await store.add(botId, { name: 'Inbox', prompt: 'Check.', schedule: EVERY_TEN_MINUTES });
        clock += 10 * MINUTE_MS;
        await failingScheduler.checkDueRoutines();
        await scheduler.checkDueRoutines();

        expect(sent)
            .toEqual([]);
        expect(consoleError)
            .toHaveBeenCalledWith(expect.not.stringContaining('Check.'));
        consoleError.mockRestore();
    });

    it('keeps running the other routines when one fails', async () => {
        const consoleError = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const partlyFailing = new RoutineScheduler({
            routineStore: store,
            sendMessage: (targetBotId, text) => (text.includes('bad') ? Promise.reject(new Error('down')) : sendMessage(targetBotId, text)),
            now: () => clock,
        });

        await store.add(botId, { name: 'bad', prompt: 'x', schedule: EVERY_TEN_MINUTES });
        await store.add(botId, { name: 'good', prompt: 'y', schedule: EVERY_TEN_MINUTES });
        clock += 10 * MINUTE_MS;
        await partlyFailing.checkDueRoutines();

        expect(sent)
            .toEqual([[botId, 'Routine "good": y']]);
        consoleError.mockRestore();
    });

    it('checks on start and then on every interval', async () => {
        vi.useFakeTimers();
        await store.add(botId, { name: 'Inbox', prompt: 'Check.', schedule: EVERY_TEN_MINUTES });
        clock += 10 * MINUTE_MS;
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(sent)
            .toHaveLength(1);

        clock += 10 * MINUTE_MS;
        await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

        expect(sent)
            .toHaveLength(2);

        scheduler.stop();
        clock += 10 * MINUTE_MS;
        await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

        expect(sent)
            .toHaveLength(2);
    });
});
