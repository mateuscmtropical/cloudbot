import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { ChatService, PendingUploadLimitError, TurnInProgressError, UploadDuringTurnError } from './ChatService.ts';

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

    it('hands uploaded files to the next message and stores them on it', async () => {
        const { service, runner } = buildSetup([{ event: { type: 'text', text: 'Got it' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const files = [new File([Buffer.from('hello')], 'notes.txt')];
        const summaries = await service.saveUploads(bot.id, files);
        const finished = waitForTurnFinish(service, bot.id);

        expect(summaries)
            .toEqual([{ name: 'notes.txt', mimeType: 'application/octet-stream', sizeBytes: 5 }]);

        const userMessage = await service.sendMessage(bot.id, 'Read this');

        await finished;

        expect(userMessage?.body)
            .toEqual({
                kind: 'text',
                text: 'Read this',
                attachments: [{ name: 'notes.txt', mimeType: 'application/octet-stream', sizeBytes: 5 }],
            });
        expect(runner.receivedRequests[0]?.prompt)
            .toContain(join(dataDir, 'uploads', bot.id));
        expect(runner.receivedRequests[0]?.prompt)
            .toContain('notes.txt');
    });

    it('sends an uploaded image to the agent as image input', async () => {
        const { service, runner } = buildSetup([{ event: { type: 'text', text: 'A cat' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const pngBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]);
        const files = [new File([pngBytes], 'photo.png')];
        const finished = waitForTurnFinish(service, bot.id);

        await service.saveUploads(bot.id, files);
        await service.sendMessage(bot.id, 'What is this?');
        await finished;

        expect(runner.receivedRequests[0]?.images)
            .toEqual([{ mediaType: 'image/png', data: pngBytes.toString('base64') }]);
    });

    it('attaches uploads only to the message sent right after them', async () => {
        const { service, runner } = buildSetup([
            { event: { type: 'session', sessionId: 'session-1' } },
            { event: { type: 'text', text: 'Done' } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const files = [new File([Buffer.from('hello')], 'notes.txt')];
        const firstFinished = waitForTurnFinish(service, bot.id);

        await service.saveUploads(bot.id, files);
        await service.sendMessage(bot.id, 'first');
        await firstFinished;

        const secondFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'second');
        await secondFinished;

        expect(runner.receivedRequests[0]?.prompt)
            .toContain(join(dataDir, 'uploads', bot.id));
        expect(runner.receivedRequests[1]?.prompt)
            .toBe('second');
    });

    it('returns undefined for uploads to an unknown bot', async () => {
        const { service } = buildSetup([]);
        const files = [new File([Buffer.from('hello')], 'notes.txt')];

        expect(await service.saveUploads('missing-bot', files))
            .toBeUndefined();
    });

    it('keeps uploads outside the workspace, in the agent upload root when an agent user is set', () => {
        const agentService = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, agentUser: 'bot' });
        const plainService = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir });

        expect(agentService.uploadDirFor('bot-1'))
            .toBe('/var/lib/cloudbot-uploads/bot-1');
        expect(plainService.uploadDirFor('bot-1'))
            .toBe(join(dataDir, 'uploads', 'bot-1'));
    });

    it('gives the agent the upload folder as an extra directory on every turn', async () => {
        const { service, runner } = buildSetup([{ event: { type: 'text', text: 'Done' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const firstFinished = waitForTurnFinish(service, bot.id);

        await service.saveUploads(bot.id, [new File(['hello'], 'notes.txt')]);
        await service.sendMessage(bot.id, 'first');
        await firstFinished;

        const secondFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'second');
        await secondFinished;

        expect(runner.receivedRequests[0]?.additionalDirectories)
            .toEqual([join(dataDir, 'uploads', bot.id)]);
        expect(runner.receivedRequests[1]?.additionalDirectories)
            .toEqual([join(dataDir, 'uploads', bot.id)]);
    });

    it('builds the image from the bytes kept in memory, even when the file is gone from disk', async () => {
        const { service, runner } = buildSetup([{ event: { type: 'text', text: 'A cat' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const pngBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]);

        await service.saveUploads(bot.id, [new File([pngBytes], 'photo.png')]);

        const uploadDir = join(dataDir, 'uploads', bot.id);
        const [storedName] = await readdir(uploadDir);
        const storedPath = join(uploadDir, storedName ?? '');

        await rm(storedPath);

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'What is this?');
        await finished;

        expect(runner.receivedRequests[0]?.images)
            .toEqual([{ mediaType: 'image/png', data: pngBytes.toString('base64') }]);
    });

    it('refuses an upload that would give the next message more than 10 files', async () => {
        const { service } = buildSetup([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const tenFiles = Array.from({ length: 10 }, (_value, index) => new File(['x'], `file-${String(index)}.txt`));

        await service.saveUploads(bot.id, tenFiles);

        await expect(service.saveUploads(bot.id, [new File(['x'], 'extra.txt')]))
            .rejects.toBeInstanceOf(PendingUploadLimitError);

        const uploadDir = join(dataDir, 'uploads', bot.id);

        expect(await readdir(uploadDir))
            .toHaveLength(10);
    });

    it('refuses an upload that would give the next message more than 20 MB and keeps nothing', async () => {
        const { service } = buildSetup([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const largeFile = new File([Buffer.alloc(21 * 1024 * 1024)], 'large.bin');

        await expect(service.saveUploads(bot.id, [largeFile]))
            .rejects.toBeInstanceOf(PendingUploadLimitError);

        const uploadDir = join(dataDir, 'uploads', bot.id);

        expect(await readdir(uploadDir))
            .toEqual([]);
    });

    it('keeps the files of a message that failed to save and refuses the upload that came in meanwhile', async () => {
        const { service, runner } = buildSetup([
            { event: { type: 'session', sessionId: 'session-1' } },
            { event: { type: 'text', text: 'Done' } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.saveUploads(bot.id, [new File(['a'], 'first.txt')]);
        const addSpy = vi.spyOn(messageStore, 'add');

        addSpy.mockImplementationOnce(async () => {
            await expect(service.saveUploads(bot.id, [new File(['b'], 'second.txt')]))
                .rejects.toBeInstanceOf(UploadDuringTurnError);

            throw new Error('database is busy');
        });

        await expect(service.sendMessage(bot.id, 'first'))
            .rejects.toThrow('database is busy');

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'second');
        await finished;

        expect(runner.receivedRequests[0]?.prompt)
            .toContain('first.txt');
        expect(runner.receivedRequests[0]?.prompt)
            .not.toContain('second.txt');
    });

    it('refuses uploads while a turn runs and keeps the queue empty', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new AbortOnlyRunner(), dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.sendMessage(bot.id, 'Hi');

        await expect(service.saveUploads(bot.id, [new File(['x'], 'late.txt')]))
            .rejects.toBeInstanceOf(UploadDuringTurnError);

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;

        expect(await service.listPendingUploads(bot.id))
            .toEqual([]);
    });

    it('removes the files of an upload that a turn starts over while they are written', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new AbortOnlyRunner(), dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        // The file is read after the first running check and after the folder exists, so a turn started
        // by that read is the one the second check has to catch.
        const lateFile = new File(['a'], 'late.txt');
        const readBytes = lateFile.arrayBuffer.bind(lateFile);

        vi.spyOn(lateFile, 'arrayBuffer')
            .mockImplementationOnce(async () => {
                await service.sendMessage(bot.id, 'Started first');

                return readBytes();
            });

        await expect(service.saveUploads(bot.id, [lateFile]))
            .rejects.toBeInstanceOf(UploadDuringTurnError);

        const uploadDir = join(dataDir, 'uploads', bot.id);

        expect(await readdir(uploadDir))
            .toEqual([]);

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;
    });

    it('puts the uploads back for the next message when the agent never starts', async () => {
        const { service } = buildSetup([{ event: { type: 'turn_error', message: 'Could not start the agent.', isUsageLimit: false } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.saveUploads(bot.id, [new File(['hello'], 'notes.txt')]);
        await service.sendMessage(bot.id, 'Read this');
        await finished;

        const queued = await service.listPendingUploads(bot.id);

        expect(queued?.map(upload => upload.name))
            .toEqual(['notes.txt']);
    });

    it('puts the uploads back when a stop arrives before the agent sends its session', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new AbortOnlyRunner(), dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.saveUploads(bot.id, [new File(['hello'], 'notes.txt')]);
        await service.sendMessage(bot.id, 'Read this');

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;

        const queued = await service.listPendingUploads(bot.id);

        expect(queued?.map(upload => upload.name))
            .toEqual(['notes.txt']);
    });

    it('lists the waiting files and removes one of them together with its file', async () => {
        const { service } = buildSetup([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.saveUploads(bot.id, [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);

        const queued = await service.listPendingUploads(bot.id);
        const firstId = queued?.[0]?.id ?? '';

        expect(queued?.map(upload => upload.name))
            .toEqual(['a.txt', 'b.txt']);
        expect(await service.removePendingUpload(bot.id, firstId))
            .toBe(true);
        expect(await service.removePendingUpload(bot.id, firstId))
            .toBe(false);

        const remaining = await service.listPendingUploads(bot.id);

        expect(remaining?.map(upload => upload.name))
            .toEqual(['b.txt']);
        expect(await readdir(join(dataDir, 'uploads', bot.id)))
            .toHaveLength(1);
        expect(await service.listPendingUploads('missing-bot'))
            .toBeUndefined();
    });

    it('caps the next message at the configured upload size instead of a fixed 20 MB', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, maxUploadBytes: 1024 });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const twoKilobytes = new File([Buffer.alloc(2048)], 'big.bin');

        await expect(service.saveUploads(bot.id, [twoKilobytes]))
            .rejects.toBeInstanceOf(PendingUploadLimitError);
    });

    it('keeps the workspace under the one path the service exposes', () => {
        const { service } = buildSetup([]);

        expect(service.workspaceFor('bot-1'))
            .toBe(join(dataDir, 'workspaces', 'bot-1'));
    });

    it('puts the workspace under the agent workspace root when the agent runs as its own user', () => {
        const agentService = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, agentUser: 'bot' });

        expect(agentService.workspaceFor('bot-1'))
            .toBe('/var/lib/cloudbot-workspaces/bot-1');
    });
});
