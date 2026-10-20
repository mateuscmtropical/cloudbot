import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import { buildSystemPrompt } from '../agent/buildSystemPrompt.ts';
import { PROFILE_SERVER_NAME, UPDATE_PROFILE_TOOL_FULL_NAME } from '../agent/createProfileToolServer.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import type { ScriptedAgentStep } from '../agent/FakeAgentRunner.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { ChatEvent } from '../../shared/chatTypes.ts';
import { ChatService, TurnInProgressError } from './ChatService.ts';

interface TestSetup {
    service: ChatService;
    runner: FakeAgentRunner;
}

// Resolves on the next turn event that reports the turn as finished. Subscribe before sending.
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

function describeEvent(event: ChatEvent): string {
    if (event.type === 'turn') {
        return `turn:${String(event.isRunning)}`;
    }

    if (event.type === 'textDelta') {
        return `delta:${event.text}`;
    }

    return `message:${event.message.role}:${event.message.body.kind}`;
}

// Like the SDK runner, this one only learns about a stop from the abort event.
// A signal that is already aborted never fires that event again, so the turn would hang.
class AbortOnlyRunner implements AgentRunner {
    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        return waitForAbort(request.abortSignal);
    }
}

async function* waitForAbort(abortSignal: AbortSignal): AsyncGenerator<AgentEvent> {
    await new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => {
            resolve();
        }, { once: true });
    });

    yield { type: 'turn_finished' };
}

describe('ChatService', () => {
    it('sends the agent workspace path and creates nothing under the data folder when an agent user is set', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Hello' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir, agentUser: 'bot' });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        expect(runner.receivedRequests[0]?.workspaceDir)
            .toBe(`/var/lib/cloudbot-workspaces/${bot.id}`);
        expect(existsSync(join(dataDir, 'workspaces')))
            .toBe(false);
    });

    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-chat-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true });
    });

    function buildSetup(script: ScriptedAgentStep[]): TestSetup {
        const runner = new FakeAgentRunner(script);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });

        return { service, runner };
    }

    it('stores the user message and the assistant reply, then finishes the turn', async () => {
        const { service } = buildSetup([{ event: { type: 'text', text: 'Hello' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        const storedMessages = await service.listMessages(bot.id);

        expect(storedMessages?.map(message => message.body))
            .toEqual([{ kind: 'text', text: 'Hi' }, { kind: 'text', text: 'Hello' }]);
        expect(storedMessages?.map(message => message.role))
            .toEqual(['user', 'assistant']);
    });

    it('publishes the events of a turn in order', async () => {
        const { service } = buildSetup([{ event: { type: 'text', text: 'Hello' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const receivedEvents: ChatEvent[] = [];
        const unsubscribe = service.subscribe(bot.id, (event) => {
            receivedEvents.push(event);
        });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;
        unsubscribe();

        expect(receivedEvents.map(describeEvent))
            .toEqual(['turn:true', 'message:user:text', 'message:assistant:text', 'turn:false']);
    });

    it('sends the deltas of a text block before its finished message', async () => {
        const { service } = buildSetup([
            { event: { type: 'text_delta', text: 'Hel' } },
            { event: { type: 'text_delta', text: 'lo' } },
            { event: { type: 'text', text: 'Hello' } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const receivedEvents: ChatEvent[] = [];
        const unsubscribe = service.subscribe(bot.id, (event) => {
            receivedEvents.push(event);
        });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;
        unsubscribe();

        expect(receivedEvents.map(describeEvent))
            .toEqual([
                'turn:true',
                'message:user:text',
                'delta:Hel',
                'delta:lo',
                'message:assistant:text',
                'turn:false',
            ]);

        const storedMessages = await service.listMessages(bot.id);

        expect(storedMessages?.map(message => message.body))
            .toEqual([{ kind: 'text', text: 'Hi' }, { kind: 'text', text: 'Hello' }]);
    });

    it('keeps the session id from the runner so the next turn resumes it', async () => {
        const { service, runner } = buildSetup([
            { event: { type: 'session', sessionId: 'session-1' } },
            { event: { type: 'text', text: 'One' } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        const firstFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'first');
        await firstFinished;

        const secondFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'second');
        await secondFinished;

        expect(runner.receivedRequests[0]?.sessionId)
            .toBeUndefined();
        expect(runner.receivedRequests[1]?.sessionId)
            .toBe('session-1');
        expect(await botStore.getById(bot.id))
            .toMatchObject({ sessionId: 'session-1' });
    });

    it('stores a finished tool call with the name from when it started', async () => {
        const { service } = buildSetup([
            { event: { type: 'tool_started', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'ls' } } },
            { event: { type: 'tool_finished', toolUseId: 'tool-1', isError: false, output: 'a.txt' } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'list files');
        await finished;

        const storedMessages = await service.listMessages(bot.id);

        expect(storedMessages?.[1]?.body)
            .toEqual({ kind: 'toolActivity', toolName: 'Bash', status: 'done', summary: 'a.txt' });
    });

    it('stores a turn error as a system message', async () => {
        const { service } = buildSetup([
            { event: { type: 'turn_error', message: 'Usage limit reached', isUsageLimit: true } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'hi');
        await finished;

        const storedMessages = await service.listMessages(bot.id);

        expect(storedMessages?.[1])
            .toMatchObject({ role: 'system', body: { kind: 'text', text: 'Usage limit reached' } });
    });

    it('rejects a second message while the first turn is still running', async () => {
        const { service } = buildSetup([{ event: { type: 'text', text: 'Late' }, delayMs: 60_000 }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.sendMessage(bot.id, 'first');

        await expect(service.sendMessage(bot.id, 'second'))
            .rejects.toBeInstanceOf(TurnInProgressError);

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;
    });

    it('stops a running turn and keeps only the messages stored before the stop', async () => {
        const { service } = buildSetup([
            { event: { type: 'text', text: 'Partial' }, delayMs: 60_000 },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.sendMessage(bot.id, 'Hi');

        const finished = waitForTurnFinish(service, bot.id);
        const stopResult = await service.stopTurn(bot.id);

        await finished;

        const storedMessages = await service.listMessages(bot.id);

        expect(stopResult)
            .toBe(true);
        expect(storedMessages?.map(message => message.role))
            .toEqual(['user']);
    });

    it('reports no running turn when stopping an idle bot, and undefined for an unknown bot', async () => {
        const { service } = buildSetup([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        expect(await service.stopTurn(bot.id))
            .toBe(false);
        expect(await service.stopTurn('missing-bot'))
            .toBeUndefined();
    });

    it('returns undefined when sending to an unknown bot', async () => {
        const { service } = buildSetup([]);

        expect(await service.sendMessage('missing-bot', 'hi'))
            .toBeUndefined();
    });

    it('shows the latest message as the preview on the bot list', async () => {
        const { service } = buildSetup([{ event: { type: 'text', text: 'Hello there' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        const bots = await service.listBots();

        expect(bots)
            .toEqual([
                expect.objectContaining({ id: bot.id, name: 'Ana', lastMessagePreview: 'Hello there' }),
            ]);
    });

    it('passes the profile tool, its allowed name and the bot prompt to each turn', async () => {
        const { service, runner } = buildSetup([{ event: { type: 'text', text: 'Hello' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: 'Helps with mail' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        const turnRequest = runner.receivedRequests[0];

        expect(turnRequest?.mcpServers)
            .toHaveProperty([PROFILE_SERVER_NAME], expect.objectContaining({ type: 'sdk' }));
        expect(turnRequest?.allowedTools)
            .toEqual([UPDATE_PROFILE_TOOL_FULL_NAME]);
        expect(turnRequest?.systemPrompt)
            .toBe(buildSystemPrompt(bot));
    });

    it('stops a turn without hanging when the stop arrives before the runner starts', async () => {
        const runner = new AbortOnlyRunner();
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.sendMessage(bot.id, 'Hi');

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;

        const storedMessages = await service.listMessages(bot.id);

        expect(storedMessages?.map(message => message.role))
            .toEqual(['user']);
    });

    it('starts a fresh session when a resumed session fails before it starts', async () => {
        const resumeRunner = new FakeAgentRunner([
            { event: { type: 'turn_error', message: 'Session not found', isUsageLimit: false } },
        ]);
        const freshRunner = new FakeAgentRunner([
            { event: { type: 'session', sessionId: 'session-2' } },
            { event: { type: 'text', text: 'Fresh reply' } },
        ]);
        const runner: AgentRunner = {
            runTurn: (request: TurnRequest) => (request.sessionId === undefined
                ? freshRunner.runTurn(request)
                : resumeRunner.runTurn(request)),
        };
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await botStore.setSessionId(bot.id, 'stale-session');

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        const storedMessages = await service.listMessages(bot.id);
        const storedBot = await botStore.getById(bot.id);

        expect(storedMessages?.map(message => message.body))
            .toEqual([{ kind: 'text', text: 'Hi' }, { kind: 'text', text: 'Fresh reply' }]);
        expect(storedBot?.sessionId)
            .toBe('session-2');
    });
});
