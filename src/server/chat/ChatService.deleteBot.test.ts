import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { count, eq } from 'drizzle-orm';
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectedApps } from '../apps/ConnectedApps.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import type { ScriptedAgentStep } from '../agent/FakeAgentRunner.ts';
import { BotDeletingError } from '../bots/BotDeletingError.ts';
import { encodeProjectPath } from '../bots/claudeProjectFolder.ts';
import { BotSecrets } from '../secrets/BotSecrets.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import { botLimits, botModels, botRules, integrationRuns, integrations, messages, routines, turnQueue, turnWaits, watches, webhooks } from '../store/schema.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { RuleStore } from '../store/RuleStore.ts';
import { Vault } from '../vault/Vault.ts';
import { ChatService } from './ChatService.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

type AppDatabase = OpenedDatabase['db'];

// Every table that keeps rows of one bot, with its bot id column. The count of each must be zero once the bot is deleted.
const PER_BOT_TABLES: [string, AnySQLiteTable, AnySQLiteColumn][] = [
    ['messages', messages, messages.botId],
    ['turn_queue', turnQueue, turnQueue.botId],
    ['turn_waits', turnWaits, turnWaits.botId],
    ['bot_rules', botRules, botRules.botId],
    ['routines', routines, routines.botId],
    ['webhooks', webhooks, webhooks.botId],
    ['watches', watches, watches.botId],
    ['bot_models', botModels, botModels.botId],
    ['bot_limits', botLimits, botLimits.botId],
    ['integrations', integrations, integrations.botId],
];

// One row in each per-bot table, so the cascade has something to remove.
async function seedBotRows(db: AppDatabase, botId: string): Promise<void> {
    const integrationId = `integration-${botId}`;

    await db.insert(messages)
        .values({ id: `message-${botId}`, botId, role: 'user', kind: 'text', content: { kind: 'text', text: 'hi' }, createdAt: 1 });
    await db.insert(turnQueue)
        .values({ id: `turn-${botId}`, botId, position: 0, messageId: null, text: 'Continue.', uploads: [], source: 'chat' });
    await db.insert(turnWaits)
        .values({ botId, resumeAt: 1 });
    await db.insert(botRules)
        .values({ id: `rule-${botId}`, botId, kind: 'allow', text: 'Track grants.', blockedTools: [], createdAt: 1 });
    await db.insert(routines)
        .values({ id: `routine-${botId}`, botId, name: 'Daily', prompt: 'Check.', schedule: { kind: 'daily', hour: 9, minute: 0 }, isEnabled: true, nextRunAt: 1, createdAt: 1 });
    await db.insert(webhooks)
        .values({ id: `webhook-${botId}`, botId, name: 'Form', tokenHash: `hash-${botId}`, createdAt: 1 });
    await db.insert(watches)
        .values({ id: `watch-${botId}`, botId, name: 'Page', url: 'https://example.com', intervalMinutes: 60, nextCheckAt: 1, createdAt: 1 });
    await db.insert(botModels)
        .values({ botId });
    await db.insert(botLimits)
        .values({ botId });
    await db.insert(integrations)
        .values({ id: integrationId, botId, name: 'Sync', entryPath: 'sync.py', command: 'python3', entryHash: 'hash', createdAt: 1, updatedAt: 1 });
    await db.insert(integrationRuns)
        .values({ id: `run-${botId}`, integrationId, startedAt: 1, timedOut: false, output: 'done' });
}

async function countRows(db: AppDatabase, table: AnySQLiteTable, column: AnySQLiteColumn, botId: string): Promise<number> {
    const rows = await db.select({ count: count() })
        .from(table)
        .where(eq(column, botId));

    return rows[0]?.count ?? 0;
}

function pathExists(path: string): Promise<boolean> {
    return lstat(path)
        .then(() => true)
        .catch(() => false);
}

async function makeBotFolders(dataDir: string, botId: string): Promise<void> {
    const folders = [join(dataDir, 'workspaces', botId), join(dataDir, 'uploads', botId), join(dataDir, 'shared', botId)];

    await Promise.all(folders.map(async (folder) => {
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'file.txt'), 'data');
    }));
}

describe('ChatService.deleteBot', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;
    let secrets: BotSecrets;
    let removeSavedBy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-delete-bot-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
        secrets = new BotSecrets(new Vault(dataDir));
        removeSavedBy = vi.fn(() => Promise.resolve());
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    function buildService(script: ScriptedAgentStep[] = []): ChatService {
        const connectedApps = { removeSavedBy } as unknown as ConnectedApps;

        return new ChatService({
            botStore,
            messageStore,
            runner: new FakeAgentRunner(script),
            dataDir,
            botSecrets: secrets,
            connectedApps,
            ruleStore: new RuleStore(opened.db),
        });
    }

    it('removes the bot\'s Claude Code transcripts from CloudBot\'s own config folder', async () => {
        const configDir = join(dataDir, 'claude-config');
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const service = new ChatService({
            botStore,
            messageStore,
            runner: new FakeAgentRunner([]),
            dataDir,
            botSecrets: secrets,
            claudeConfigDir: configDir,
            ruleStore: new RuleStore(opened.db),
        });
        const projectFolder = join(configDir, 'projects', encodeProjectPath(join(dataDir, 'workspaces', bot.id)));

        await mkdir(projectFolder, { recursive: true });
        await writeFile(join(projectFolder, 'transcript.jsonl'), 'data');

        await service.deleteBot(bot.id);

        expect(await pathExists(projectFolder))
            .toBe(false);
    });

    it('removes every row, folder and secret of the bot, and keeps the other bot', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const otherBot = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        await seedBotRows(opened.db, bot.id);
        await seedBotRows(opened.db, otherBot.id);
        await makeBotFolders(dataDir, bot.id);
        await makeBotFolders(dataDir, otherBot.id);
        secrets.save(bot.id, 'GITHUB_TOKEN', 'https://github.com', 'first-token');
        secrets.save(otherBot.id, 'GITHUB_TOKEN', 'https://github.com', 'second-token');

        const outcome = await buildService()
            .deleteBot(bot.id);

        expect(outcome)
            .toBe('deleted');
        const counts = await Promise.all(PER_BOT_TABLES.map(async ([name, table, column]) => ({
            name,
            mine: await countRows(opened.db, table, column, bot.id),
            other: await countRows(opened.db, table, column, otherBot.id),
        })));

        counts.forEach(({ name, mine, other }) => {
            expect(mine, name)
                .toBe(0);
            expect(other, name)
                .toBe(1);
        });
        const runs = await opened.db.select({ count: count() })
            .from(integrationRuns)
            .where(eq(integrationRuns.integrationId, `integration-${bot.id}`));

        expect(runs[0]?.count)
            .toBe(0);
        expect(await botStore.getById(bot.id))
            .toBeUndefined();
        expect(removeSavedBy)
            .toHaveBeenCalledWith(bot.id);
        expect(secrets.read(bot.id, 'GITHUB_TOKEN'))
            .toBeUndefined();
        expect(secrets.read(otherBot.id, 'GITHUB_TOKEN')?.value)
            .toBe('second-token');
        expect(await pathExists(join(dataDir, 'workspaces', bot.id)))
            .toBe(false);
        expect(await pathExists(join(dataDir, 'uploads', bot.id)))
            .toBe(false);
        expect(await pathExists(join(dataDir, 'shared', bot.id)))
            .toBe(false);
        expect(await pathExists(join(dataDir, 'workspaces', otherBot.id, 'file.txt')))
            .toBe(true);
    });

    it('refuses to delete the last bot', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        expect(await buildService()
            .deleteBot(bot.id))
            .toBe('last');
        expect(await botStore.getById(bot.id))
            .toBeDefined();
    });

    it('tells the listeners the bot is gone before they are dropped', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        const service = buildService();
        const listener = vi.fn();

        service.subscribe(bot.id, listener);

        expect(await service.deleteBot(bot.id))
            .toBe('deleted');
        expect(listener)
            .toHaveBeenCalledWith({ type: 'botDeleted', botId: bot.id });
    });

    it('gives the approval card the same refusals as the delete, and the name when the delete is allowed', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const service = buildService();

        expect(await service.describeBotDelete(bot.id))
            .toEqual({ ok: false, reason: 'This is the last bot, so it cannot be deleted.' });

        await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        expect(await service.describeBotDelete(bot.id))
            .toEqual({ ok: true, name: 'Ana' });
        expect(await service.describeBotDelete('no-such-bot'))
            .toEqual({ ok: false, reason: 'This bot no longer exists.' });
    });

    it('answers missing for a bot that does not exist', async () => {
        await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        expect(await buildService()
            .deleteBot('no-such-bot'))
            .toBe('missing');
    });

    it('stops a running turn before the bot is deleted', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        const service = buildService([{ event: { type: 'text', text: 'Late' }, delayMs: 60_000 }]);

        await service.sendMessage(bot.id, 'Hello');
        expect(service.isTurnRunning(bot.id))
            .toBe(true);

        const outcome = await service.deleteBot(bot.id);

        expect(outcome)
            .toBe('deleted');
        expect(service.isTurnRunning(bot.id))
            .toBe(false);
        expect(await botStore.getById(bot.id))
            .toBeUndefined();
    });

    it('keeps the bot working, with its running turn restarted, when a step of the delete fails', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        // The turns still read the app servers, so the stand-in answers that read with none.
        const failingApps = {
            removeSavedBy: vi.fn(() => Promise.reject(new Error('The vault is locked.'))),
            serverConfigs: vi.fn(() => Promise.resolve({})),
        } as unknown as ConnectedApps;
        const service = new ChatService({
            botStore,
            messageStore,
            runner: new FakeAgentRunner([{ event: { type: 'text', text: 'Late' }, delayMs: 60_000 }]),
            dataDir,
            botSecrets: secrets,
            connectedApps: failingApps,
        });

        await service.sendMessage(bot.id, 'Hello');
        await service.sendMessage(bot.id, 'Second');

        await expect(service.deleteBot(bot.id))
            .rejects.toThrow('The vault is locked.');
        expect(await botStore.getById(bot.id))
            .toBeDefined();
        expect(service.isTurnRunning(bot.id))
            .toBe(true);
    });

    it('refuses a second delete of a bot that is already being deleted, and keeps the first one going', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        const service = buildService([{ event: { type: 'text', text: 'Late' }, delayMs: 60_000 }]);

        await service.sendMessage(bot.id, 'Hello');

        const first = service.deleteBot(bot.id);

        expect(await service.deleteBot(bot.id))
            .toBe('deleting');
        expect(await first)
            .toBe('deleted');
    });

    it('never removes the last two bots in parallel', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const service = buildService();

        const outcomes = await Promise.all([service.deleteBot(ana.id), service.deleteBot(ben.id)]);

        // Both deletes see the other as being deleted, so both are refused as the last bot. At most one may go.
        expect(outcomes.filter(outcome => outcome === 'deleted').length)
            .toBeLessThanOrEqual(1);
        expect((await botStore.list()).length)
            .toBeGreaterThanOrEqual(1);
    });

    it('refuses a message while the bot is being deleted', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        const service = buildService([{ event: { type: 'text', text: 'Late' }, delayMs: 60_000 }]);

        await service.sendMessage(bot.id, 'Hello');

        const deleting = service.deleteBot(bot.id);

        await expect(service.sendMessage(bot.id, 'Again'))
            .rejects.toBeInstanceOf(BotDeletingError);
        expect(await deleting)
            .toBe('deleted');
    });
});
