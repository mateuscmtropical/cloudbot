import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { WatchStore } from '../store/WatchStore.ts';
import { fetchWatchedPage } from './fetchWatchedPage.ts';
import type { PageFetchDeps } from './fetchWatchedPage.ts';
import { htmlToVisibleText } from './pageText.ts';
import { WatchScheduler } from './WatchScheduler.ts';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

describe('WatchScheduler', () => {
    let opened: OpenedDatabase;
    let watchStore: WatchStore;
    let botId: string;
    let clock: number;
    let page: string;
    let fetchCount: number;
    let sent: { botId: string; text: string }[];
    let failFetch: boolean;
    let failSend: boolean;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        clock = 1_000_000;
        watchStore = new WatchStore(opened.db, { now: () => clock });
        const botStore = new BotStore(opened.db);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        botId = bot.id;
        page = '<p>Bread 2</p><p>Milk 1</p>';
        fetchCount = 0;
        sent = [];
        failFetch = false;
        failSend = false;
    });

    afterEach(() => {
        opened.close();
    });

    function createScheduler(isReady: () => boolean = () => true): WatchScheduler {
        return new WatchScheduler({
            watchStore,
            fetchPage: () => {
                fetchCount += 1;

                if (failFetch) {
                    return Promise.reject(new Error('The page could not be fetched.'));
                }

                return Promise.resolve(htmlToVisibleText(page));
            },
            sendMessage: (targetBotId, text) => {
                if (failSend) {
                    return Promise.reject(new Error('The queue is down.'));
                }

                sent.push({ botId: targetBotId, text });

                return Promise.resolve(undefined);
            },
            isReady,
            now: () => clock,
        });
    }

    async function addWatch(keyword?: string): Promise<string> {
        const watch = await watchStore.addWithLimit(botId, { name: 'Shop', url: 'https://shop.example.test/', intervalMinutes: 60, keyword }, 10);

        return watch?.id ?? '';
    }

    it('records the first version of a page without waking the bot', async () => {
        await addWatch();

        await createScheduler()
            .checkDueWatches();

        expect(fetchCount)
            .toBe(1);
        expect(sent)
            .toEqual([]);
        const [stored] = await watchStore.list(botId);

        expect(stored?.textHash)
            .toMatch(/^[0-9a-f]{64}$/);
        expect(stored?.lastText)
            .toBe('Bread 2\nMilk 1');
    });

    it('wakes the bot with a diff when the text changes', async () => {
        await addWatch();
        const scheduler = createScheduler();

        await scheduler.checkDueWatches();
        page = '<p>Bread 2</p><p>Milk 3</p>';
        clock += HOUR_MS + MINUTE_MS;
        await scheduler.checkDueWatches();

        expect(sent)
            .toHaveLength(1);
        expect(sent[0]?.botId)
            .toBe(botId);
        expect(sent[0]?.text)
            .toContain('- Milk 1');
        expect(sent[0]?.text)
            .toContain('+ Milk 3');
    });

    it('does not wake the bot when nothing changed', async () => {
        await addWatch();
        const scheduler = createScheduler();

        await scheduler.checkDueWatches();
        clock += HOUR_MS + MINUTE_MS;
        await scheduler.checkDueWatches();

        expect(fetchCount)
            .toBe(2);
        expect(sent)
            .toEqual([]);
    });

    it('wakes the bot only for changes in the lines with the keyword', async () => {
        await addWatch('bread');
        const scheduler = createScheduler();

        await scheduler.checkDueWatches();
        page = '<p>Bread 2</p><p>Milk 9</p>';
        clock += HOUR_MS + MINUTE_MS;
        await scheduler.checkDueWatches();
        expect(sent)
            .toEqual([]);

        page = '<p>Bread 5</p><p>Milk 9</p>';
        clock += HOUR_MS + MINUTE_MS;
        await scheduler.checkDueWatches();
        expect(sent)
            .toHaveLength(1);
        expect(sent[0]?.text)
            .toContain('+ Bread 5');
    });

    it('keeps the last text and waits for the next check when the page cannot be fetched', async () => {
        await addWatch();
        const scheduler = createScheduler();

        await scheduler.checkDueWatches();
        const [before] = await watchStore.list(botId);

        failFetch = true;
        page = '<p>Changed</p>';
        clock += HOUR_MS + MINUTE_MS;
        await scheduler.checkDueWatches();

        const [after] = await watchStore.list(botId);

        expect(sent)
            .toEqual([]);
        expect(after?.textHash)
            .toBe(before?.textHash);
        expect(after?.nextCheckAt)
            .toBeGreaterThan(clock);
    });

    it('does not check a watch before its time', async () => {
        await addWatch();
        const scheduler = createScheduler();

        await scheduler.checkDueWatches();
        clock += 10 * MINUTE_MS;
        await scheduler.checkDueWatches();

        expect(fetchCount)
            .toBe(1);
    });

    it('waits while the bot is not ready', async () => {
        await addWatch();

        await createScheduler(() => false)
            .checkDueWatches();

        expect(fetchCount)
            .toBe(0);
    });

    it('keeps the old text when the message could not be queued, so the next check sends the change', async () => {
        await addWatch();
        const scheduler = createScheduler();

        await scheduler.checkDueWatches();
        const [before] = await watchStore.list(botId);

        failSend = true;
        page = '<p>Bread 2</p><p>Milk 3</p>';
        clock += HOUR_MS + MINUTE_MS;
        await scheduler.checkDueWatches();

        const [afterFailedSend] = await watchStore.list(botId);

        expect(sent)
            .toEqual([]);
        expect(afterFailedSend?.textHash)
            .toBe(before?.textHash);
        expect(afterFailedSend?.lastText)
            .toBe(before?.lastText);

        failSend = false;
        clock += HOUR_MS + MINUTE_MS;
        await scheduler.checkDueWatches();

        expect(sent)
            .toHaveLength(1);
        expect(sent[0]?.text)
            .toContain('+ Milk 3');
    });

    it('frees the check when the page never answers, so the next check runs', async () => {
        vi.useFakeTimers();
        const errorSpy = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);

        try {
            let resolverCalls = 0;
            const hangingDeps: PageFetchDeps = {
                resolve: () => {
                    resolverCalls += 1;

                    return new Promise<string[]>(() => undefined);
                },
                request: () => Promise.reject(new Error('not reached')),
                localAddresses: [],
            };
            const scheduler = new WatchScheduler({
                watchStore,
                fetchPage: url => fetchWatchedPage(url, hangingDeps),
                sendMessage: () => Promise.resolve(undefined),
                now: () => clock,
            });

            await addWatch();

            const firstCheck = scheduler.checkDueWatches();

            await vi.advanceTimersByTimeAsync(15 * 1000);
            await firstCheck;

            clock += HOUR_MS + MINUTE_MS;
            const secondCheck = scheduler.checkDueWatches();

            await vi.advanceTimersByTimeAsync(15 * 1000);
            await secondCheck;

            expect(resolverCalls)
                .toBe(2);
        } finally {
            errorSpy.mockRestore();
            vi.useRealTimers();
        }
    });
});

describe('WatchStore', () => {
    let opened: OpenedDatabase;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
    });

    afterEach(() => {
        opened.close();
    });

    it('refuses a watch past the limit of the bot', async () => {
        const botStore = new BotStore(opened.db);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const store = new WatchStore(opened.db);
        const newWatch = { name: 'Shop', url: 'https://shop.example.test/', intervalMinutes: 60, keyword: undefined };

        await store.addWithLimit(bot.id, newWatch, 1);

        expect(await store.addWithLimit(bot.id, newWatch, 1))
            .toBeUndefined();
        expect(await store.list(bot.id))
            .toHaveLength(1);
    });
});
