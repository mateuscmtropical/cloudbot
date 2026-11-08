import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppTriggerStore } from '../store/AppTriggerStore.ts';
import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { createTriggerTools } from './createTriggerTools.ts';
import type { TriggerToolResult } from './createTriggerTools.ts';
import type { SourceDeps } from './triggerSources.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<TriggerToolResult>;

describe('createTriggerTools', () => {
    let opened: OpenedDatabase;
    let store: AppTriggerStore;
    let botId: string;
    let hasGoogle: boolean;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new AppTriggerStore(opened.db);
        botId = (await new BotStore(opened.db)
            .create({ name: 'Ana', title: 'Assistant', description: '' })).id;
        hasGoogle = true;
    });

    afterEach(() => {
        opened.close();
    });

    function findHandler(name: string): ToolHandler {
        const deps: SourceDeps = {
            getJson: () => Promise.reject(new Error('No network in tests.')),
            githubToken: () => undefined,
            googleToken: () => Promise.resolve(hasGoogle ? 'token' : undefined),
        };
        const tools = createTriggerTools(store, botId, deps) as unknown as { name: string; handler: unknown }[];
        const found = tools.find(candidate => candidate.name === name);

        if (found === undefined) {
            throw new Error(`No tool ${name}`);
        }

        return found.handler as ToolHandler;
    }

    const issueArgs = { name: 'Issues', source: 'github_issues', target: 'o/r', prompt: 'Summarize it' };

    it('creates, lists and deletes a trigger', async () => {
        const created = await findHandler('trigger_create')(issueArgs, {});

        expect(created.isError)
            .toBeUndefined();

        const listed = await findHandler('trigger_list')({}, {});

        expect(listed.content[0]?.text)
            .toContain('github_issues o/r, every 15 minutes');

        const [record] = await store.list(botId);
        const deleted = await findHandler('trigger_delete')({ id: record?.id }, {});

        expect(deleted.isError)
            .toBeUndefined();
    });

    it('refuses a bad target, a bad interval and Gmail that is not connected', async () => {
        const badTarget = await findHandler('trigger_create')({ ...issueArgs, target: 'nope' }, {});
        const badInterval = await findHandler('trigger_create')({ ...issueArgs, intervalMinutes: 1 }, {});

        hasGoogle = false;
        const noGmail = await findHandler('trigger_create')({ ...issueArgs, source: 'gmail', target: '' }, {});

        expect(badTarget.isError)
            .toBe(true);
        expect(badInterval.isError)
            .toBe(true);
        expect(noGmail.content[0]?.text)
            .toContain('Connect apps');
        expect(await store.list(botId))
            .toHaveLength(0);
    });

    it('makes a calendar trigger only when the checks are as often as the lead time', async () => {
        const args = { name: 'Meetings', source: 'calendar_starting', prompt: 'Remind me' };
        const tooSlow = await findHandler('trigger_create')({ ...args, target: '15', intervalMinutes: 30 }, {});
        const fine = await findHandler('trigger_create')({ ...args, target: '15' }, {});

        expect(tooSlow.isError)
            .toBe(true);
        expect(fine.isError)
            .toBeUndefined();
        expect(await store.list(botId))
            .toHaveLength(1);
    });

    it('tells the bot when the owner paused a trigger', async () => {
        await findHandler('trigger_create')(issueArgs, {});

        const [record] = await store.list(botId);

        await store.setEnabled(botId, record?.id ?? '', false);

        const listed = await findHandler('trigger_list')({}, {});

        expect(listed.content[0]?.text)
            .toContain('(paused by the owner)');
    });
});
