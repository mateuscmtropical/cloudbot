import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BotTrigger } from '../../shared/triggerTypes.ts';
import { AppTriggerStore } from '../store/AppTriggerStore.ts';
import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { createTriggerRoutes } from './createTriggerRoutes.ts';

describe('trigger routes', () => {
    let opened: OpenedDatabase;
    let store: AppTriggerStore;
    let botId: string;
    let triggerId: string;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new AppTriggerStore(opened.db);

        const bot = await new BotStore(opened.db)
            .create({ name: 'Ana', title: 'Assistant', description: '' });

        botId = bot.id;

        const trigger = await store.addWithLimit(botId, { name: 'New mail', source: 'gmail', target: 'from:ana', prompt: 'Summarize it', intervalMinutes: 15 }, 10);

        triggerId = trigger?.id ?? '';
        await store.setSeen(triggerId, ['secret-id']);
    });

    afterEach(() => {
        opened.close();
    });

    function createApp(): ReturnType<typeof createTriggerRoutes> {
        return createTriggerRoutes({ triggerStore: store, hasBot: id => Promise.resolve(id === botId) });
    }

    function putEnabled(path: string, body: string): Response | Promise<Response> {
        return createApp()
            .request(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    }

    it('lists the triggers of a bot with the source name and without the seen ids', async () => {
        const response = await createApp()
            .request(`/api/bots/${botId}/triggers`);
        const listed = await response.json() as BotTrigger[];

        expect(response.status)
            .toBe(200);
        expect(listed)
            .toEqual([expect.objectContaining({ id: triggerId, name: 'New mail', source: 'gmail', sourceLabel: 'Gmail', target: 'from:ana', prompt: 'Summarize it', intervalMinutes: 15, isEnabled: true, lastCheckedAt: null })]);
        expect(JSON.stringify(listed))
            .not.toContain('secret-id');
    });

    it('answers 404 for a bot that does not exist', async () => {
        const response = await createApp()
            .request('/api/bots/missing/triggers');

        expect(response.status)
            .toBe(404);
    });

    it('pauses and resumes a trigger, and resuming drops the seen ids', async () => {
        const paused = await putEnabled(`/api/bots/${botId}/triggers/${triggerId}/enabled`, '{"isEnabled":false}');

        expect(paused.status)
            .toBe(200);
        expect(await paused.json())
            .toEqual(expect.objectContaining({ id: triggerId, isEnabled: false }));
        expect((await store.list(botId))[0]?.seen)
            .toEqual(['secret-id']);

        const resumed = await putEnabled(`/api/bots/${botId}/triggers/${triggerId}/enabled`, '{"isEnabled":true}');

        expect(await resumed.json())
            .toEqual(expect.objectContaining({ isEnabled: true }));
        expect((await store.list(botId))[0]?.seen)
            .toBeNull();
    });

    it('refuses a body without a boolean and answers 404 for an unknown trigger', async () => {
        const bad = await putEnabled(`/api/bots/${botId}/triggers/${triggerId}/enabled`, '{"isEnabled":"no"}');
        const notJson = await putEnabled(`/api/bots/${botId}/triggers/${triggerId}/enabled`, 'nope');
        const unknown = await putEnabled(`/api/bots/${botId}/triggers/unknown/enabled`, '{"isEnabled":false}');
        const otherBot = await putEnabled(`/api/bots/other/triggers/${triggerId}/enabled`, '{"isEnabled":false}');

        expect(bad.status)
            .toBe(400);
        expect(notJson.status)
            .toBe(400);
        expect(unknown.status)
            .toBe(404);
        expect(otherBot.status)
            .toBe(404);
        expect((await store.list(botId))[0]?.isEnabled)
            .toBe(true);
    });

    it('removes a trigger of its own bot, and answers 404 for another id or bot', async () => {
        const missing = await createApp()
            .request(`/api/bots/${botId}/triggers/unknown`, { method: 'DELETE' });
        const otherBot = await createApp()
            .request(`/api/bots/other/triggers/${triggerId}`, { method: 'DELETE' });
        const removed = await createApp()
            .request(`/api/bots/${botId}/triggers/${triggerId}`, { method: 'DELETE' });

        expect(missing.status)
            .toBe(404);
        expect(otherBot.status)
            .toBe(404);
        expect(removed.status)
            .toBe(204);
        expect(await store.list(botId))
            .toEqual([]);
    });
});
