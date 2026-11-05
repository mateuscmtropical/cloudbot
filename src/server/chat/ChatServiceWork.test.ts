import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatEvent } from '../../shared/chatTypes.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { ProviderToolDependencies } from '../providers/createProviderTools.ts';
import { WorkSettings } from '../providers/WorkSettings.ts';
import type { ProviderId } from '../providers/providerIds.ts';
import { ProviderModelCatalogs } from '../providers/ProviderModelCatalogs.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import { ModelStore } from '../store/ModelStore.ts';
import { RoutineStore } from '../store/RoutineStore.ts';
import { routines } from '../store/schema.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { SettingsStore } from '../store/SettingsStore.ts';
import { ChatService } from './ChatService.ts';

const SCRIPT: { event: AgentEvent }[] = [
    { event: { type: 'session', sessionId: 'gemini:new-session' } },
    { event: { type: 'text', text: 'Done.' } },
    { event: { type: 'turn_finished' } },
];

type RunSource = 'chat' | 'routine' | 'checkin' | 'webhook';

function waitForTurnFinish(service: ChatService, botId: string): Promise<void> {
    return new Promise((resolve) => {
        const unsubscribe = service.subscribe(botId, (event: ChatEvent) => {
            if (event.type === 'turn' && !event.isRunning) {
                unsubscribe();
                resolve();
            }
        });
    });
}

describe('ChatService work on its own provider', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;
    let workSettings: WorkSettings;
    let modelStore: ModelStore;
    let routineStore: RoutineStore;
    let providerTools: ProviderToolDependencies;
    let connectedIds: ProviderId[];

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-work-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
        modelStore = new ModelStore(opened.db);
        routineStore = new RoutineStore(opened.db);

        const settings = new SettingsStore(opened.db);
        const available: ProviderId[] = ['claude', 'gemini'];
        const modelCatalogs = new ProviderModelCatalogs();

        connectedIds = ['claude', 'gemini'];
        modelCatalogs.set('gemini', { models: [{ id: 'flash', label: 'Flash', efforts: ['low'] }], defaultModel: 'flash', defaultEffort: null });
        providerTools = {
            available,
            connected: () => Promise.resolve(connectedIds),
            providerFor: () => Promise.resolve('claude'),
            setProvider: () => Promise.resolve(),
            offerProviders: () => Promise.resolve(),
        };
        workSettings = new WorkSettings({
            settings,
            modelStore,
            modelCatalogs,
            providerFor: () => Promise.resolve('claude'),
            available: () => available,
            connected: () => Promise.resolve(connectedIds),
        });
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    });

    async function runOne(runner: FakeAgentRunner, botId: string, source: RunSource, routineId?: string): Promise<void> {
        const service = new ChatService({ botStore, messageStore, runner, dataDir, modelStore, providerTools, workSettings, routineStore });
        const finished = waitForTurnFinish(service, botId);

        await service.sendMessage(botId, 'Hi', source, undefined, undefined, routineId);
        await finished;
    }

    // A routine with its own provider, model and effort, stored the way the routines form saves them.
    async function addRoutine(botId: string, provider: string | null, model: string | null, effort: string | null): Promise<string> {
        const routine = await routineStore.add(botId, { name: 'Digest', prompt: 'Summarize the news', schedule: { kind: 'interval', everyMinutes: 60 } });

        await opened.db.update(routines)
            .set({ provider, model, effort })
            .where(eq(routines.id, routine.id));

        return routine.id;
    }

    it('runs a routine apart from the chat session of another provider', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);

        await botStore.setSessionId(bot.id, 'claude:chat-session');
        await workSettings.save(bot.id, 'routines', { provider: 'gemini', model: 'flash', effort: 'low' });
        await runOne(runner, bot.id, 'routine');

        expect(runner.receivedRequests[0])
            .toMatchObject({ provider: 'gemini', model: 'flash', effort: 'low' });
        expect(runner.receivedRequests[0])
            .not.toHaveProperty('sessionId');

        const stored = await botStore.getById(bot.id);

        expect(stored?.sessionId)
            .toBe('claude:chat-session');
    });

    it('leaves the chat on its own provider and session', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);

        await botStore.setSessionId(bot.id, 'claude:chat-session');
        await workSettings.save(bot.id, 'routines', { provider: 'gemini', model: 'flash', effort: 'low' });
        await runOne(runner, bot.id, 'chat');

        expect(runner.receivedRequests[0])
            .not.toHaveProperty('provider');
        expect(runner.receivedRequests[0]?.sessionId)
            .toBe('claude:chat-session');
    });

    it('runs a check-in on the check-ins choice and not on the routines one', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);

        await workSettings.save(bot.id, 'routines', { provider: 'gemini', model: 'flash', effort: 'low' });
        await runOne(runner, bot.id, 'checkin');

        expect(runner.receivedRequests[0])
            .not.toHaveProperty('provider');
    });

    it('runs a check-in on the check-ins choice', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);

        await workSettings.save(bot.id, 'checkins', { provider: 'gemini', model: 'flash', effort: 'low' });
        await runOne(runner, bot.id, 'checkin');

        expect(runner.receivedRequests[0])
            .toMatchObject({ provider: 'gemini', model: 'flash', effort: 'low' });
    });

    it('runs a webhook on the webhooks choice', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);

        await workSettings.save(bot.id, 'routines', { provider: 'claude', model: 'opus', effort: null });
        await workSettings.save(bot.id, 'webhooks', { provider: 'gemini', model: 'flash', effort: 'low' });
        await runOne(runner, bot.id, 'webhook');

        expect(runner.receivedRequests[0])
            .toMatchObject({ provider: 'gemini', model: 'flash', effort: 'low' });
    });

    it('runs a routine on its own provider, model and effort instead of the routines choice', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);
        const routineId = await addRoutine(bot.id, 'gemini', 'flash', 'low');

        await workSettings.save(bot.id, 'routines', { provider: null, model: 'haiku', effort: null });
        await runOne(runner, bot.id, 'routine', routineId);

        expect(runner.receivedRequests[0])
            .toMatchObject({ provider: 'gemini', model: 'flash', effort: 'low' });
    });

    it('runs a quiet routine, a check-in, on its own provider too', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);
        const routineId = await addRoutine(bot.id, 'gemini', 'flash', null);

        await runOne(runner, bot.id, 'checkin', routineId);

        expect(runner.receivedRequests[0])
            .toMatchObject({ provider: 'gemini', model: 'flash' });
    });

    it('ignores a routine provider that is no longer connected and uses the routines choice', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);
        const routineId = await addRoutine(bot.id, 'gemini', 'flash', 'low');

        connectedIds = ['claude'];
        await runOne(runner, bot.id, 'routine', routineId);

        expect(runner.receivedRequests[0])
            .not.toHaveProperty('provider');
        expect(runner.receivedRequests[0])
            .not.toHaveProperty('model', 'flash');
    });

    it('offers helper_run for a helper on another provider, and no Claude helper for it', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);

        await workSettings.save(bot.id, 'documents', { provider: 'gemini', model: null, effort: null });
        await runOne(runner, bot.id, 'chat');

        const request = runner.receivedRequests[0];
        const toolNames = request?.tools?.map(tool => tool.name);

        expect(toolNames)
            .toContain('helper_run');
        expect(request?.agents)
            .toBeUndefined();
        expect(request?.systemPrompt)
            .toContain('helper_run with the documents helper');
    });

    it('runs a Claude helper the usual way and does not offer helper_run', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);

        await workSettings.save(bot.id, 'documents', { provider: null, model: 'haiku', effort: null });
        await runOne(runner, bot.id, 'chat');

        const request = runner.receivedRequests[0];
        const toolNames = request?.tools?.map(tool => tool.name);

        expect(toolNames)
            .not.toContain('helper_run');
        expect(Object.keys(request?.agents ?? {}))
            .toEqual(['documents']);
    });

    it('hands web search to a search helper on another provider, and blocks web search in the main turn', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);

        await workSettings.save(bot.id, 'search', { provider: 'gemini', model: null, effort: null });
        await runOne(runner, bot.id, 'chat');

        const request = runner.receivedRequests[0];

        expect(request?.systemPrompt)
            .toContain('helper_run with the search helper');
        expect(request?.disallowedTools)
            .toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
    });

    it('runs a Claude search helper as its own turn, and blocks the web tools in the main turn', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);

        await workSettings.save(bot.id, 'search', { provider: null, model: 'haiku', effort: null });
        await runOne(runner, bot.id, 'chat');

        const request = runner.receivedRequests[0];

        const helperTool = request?.tools?.find(tool => tool.name === 'helper_run');

        // The CLI would take the web tools from a subagent too, so the search helper runs as its own turn.
        expect(request?.agents?.search)
            .toBeUndefined();
        expect(helperTool)
            .toBeDefined();
        expect(request?.disallowedTools)
            .toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
    });

    it('leaves web search open to the main turn when no search helper is chosen', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);

        await runOne(runner, bot.id, 'chat');

        const request = runner.receivedRequests[0];

        expect(request?.disallowedTools)
            .not.toContain('WebSearch');
        expect(request?.agents?.search)
            .toBeUndefined();
    });

    it('offers the bot the real choices through its tools', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(SCRIPT);

        await workSettings.noteDefaultModel('claude', 'claude-opus-5-5');
        await runOne(runner, bot.id, 'chat');

        const listTool = runner.receivedRequests[0]?.tools?.find(tool => tool.name === 'work_settings_list');
        const result = await listTool?.handler({}, undefined);

        expect(JSON.stringify(result))
            .toContain('chat: Claude, model claude-opus-5-5');
        expect(JSON.stringify(result))
            .toContain('review: Claude, model claude-opus-5-5');
    });
});
