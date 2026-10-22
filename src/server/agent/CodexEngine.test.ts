import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './AgentEvent.ts';
import type { ToolCallDecision, TurnRequest } from './AgentRunner.ts';
import { CodexEngine, buildCodexArguments } from './CodexEngine.ts';
import type { SpawnFunction } from './ClaudeCliEngine.ts';

interface SentMessage {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
}

// A stand-in for `codex app-server`. It answers the setup calls, then plays the turn the test gives it.
class FakeAppServer extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly sent: SentMessage[] = [];
    pid = 4242;
    private readonly onTurn: (server: FakeAppServer) => void;
    private readonly failThreadStart: boolean;

    constructor(onTurn: (server: FakeAppServer) => void, failThreadStart = false) {
        super();
        this.onTurn = onTurn;
        this.failThreadStart = failThreadStart;
        let buffer = '';

        this.stdin.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            const parts = buffer.split('\n');

            buffer = parts.pop() ?? '';
            parts.filter(part => part !== '')
                .forEach((part) => {
                    this.receive(JSON.parse(part) as SentMessage);
                });
        });
        this.stdin.on('finish', () => {
            this.exit();
        });
    }

    say(message: unknown): void {
        this.stdout.write(`${JSON.stringify(message)}\n`);
    }

    exit(): void {
        if (!this.stdout.writableEnded) {
            this.stdout.end();
            this.emit('exit', 0);
        }
    }

    private receive(message: SentMessage): void {
        this.sent.push(message);

        if (message.method === 'initialize') {
            this.say({ id: message.id, result: { userAgent: 'fake', codexHome: '/x', platformFamily: 'unix', platformOs: 'linux' } });
        }

        if (message.method === 'thread/start' || message.method === 'thread/resume') {
            if (this.failThreadStart) {
                this.say({ id: message.id, error: { code: -32600, message: 'bad config' } });

                return;
            }

            const threadId = typeof message.params?.threadId === 'string' ? message.params.threadId : 'thread-1';

            this.say({ id: message.id, result: { thread: { id: threadId } } });
        }

        if (message.method === 'turn/start') {
            this.say({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
            this.say({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
            this.onTurn(this);
        }

        if (message.method === 'turn/interrupt') {
            this.say({ id: message.id, result: {} });
            this.say({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', error: null, durationMs: null } } });
        }
    }
}

function completeTurn(server: FakeAppServer): void {
    server.say({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, durationMs: 50 } } });
}

function makeEngine(onTurn: (server: FakeAppServer) => void, options: { failThreadStart?: boolean; environment?: Record<string, string> } = {}): {
    engine: CodexEngine;
    servers: FakeAppServer[];
    spawnOptions: SpawnOptions[];
    spawnArgs: string[][];
    signals: string[];
    home: string;
} {
    const servers: FakeAppServer[] = [];
    const spawnOptions: SpawnOptions[] = [];
    const spawnArgs: string[][] = [];
    const signals: string[] = [];
    const home = join(mkdtempSync(join(tmpdir(), 'cloudbot-codex-test-')), 'codex-home');
    const spawnFunction: SpawnFunction = (_command, args, spawned) => {
        const server = new FakeAppServer(onTurn, options.failThreadStart);

        servers.push(server);
        spawnOptions.push(spawned);
        spawnArgs.push(args);

        return server as unknown as ChildProcess;
    };
    const engine = new CodexEngine({
        codexPath: '/usr/local/bin/codex',
        codexHomeFor: () => home,
        environment: options.environment ?? { PATH: '/usr/bin' },
        spawnFunction,
        signalProcess: (_child, action) => {
            signals.push(action);
        },
    });

    return { engine, servers, spawnOptions, spawnArgs, signals, home };
}

function makeRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
    return { botId: 'bot-1', workspaceDir: tmpdir(), prompt: 'hello', abortSignal: new AbortController().signal, ...overrides };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const collected: AgentEvent[] = [];

    // The events are an async iterator, so `for await` is the only loop form that fits.
    for await (const event of events) {
        collected.push(event);
    }

    return collected;
}

function significant(events: AgentEvent[]): AgentEvent[] {
    return events.filter(event => event.type !== 'activity');
}

describe('buildCodexArguments', () => {
    it('runs the app server with the built-ins that have no approval turned off', () => {
        expect(buildCodexArguments([]))
            .toEqual(['app-server', '-c', 'web_search="disabled"', '-c', 'features.view_image=false', '-c', 'features.multi_agent=false', '-c', 'features.goals=false', '-c', 'shell_environment_policy.exclude=["CODEX_HOME"]']);
    });
});

describe('CodexEngine', () => {
    it('refuses a relative Codex path', () => {
        expect(() => new CodexEngine({ codexPath: 'codex', codexHomeFor: () => '/x' }))
            .toThrow('absolute');
    });

    it('starts a thread that asks before every call, streams the turn and reports the thread as the session', async () => {
        const { engine, servers, spawnOptions, home } = makeEngine((server) => {
            server.say({ method: 'item/agentMessage/delta', params: { itemId: 'm', delta: 'Hi' } });
            server.say({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm', text: 'Hi' } } });
            completeTurn(server);
        });

        const events = await collect(engine.runTurn(makeRequest({ systemPrompt: 'You are Ana.' })));
        const threadStart = servers[0]?.sent.find(message => message.method === 'thread/start');
        const turnStart = servers[0]?.sent.find(message => message.method === 'turn/start');

        expect(significant(events))
            .toEqual([
                { type: 'session', sessionId: 'thread-1' },
                { type: 'text_delta', text: 'Hi' },
                { type: 'text', text: 'Hi' },
                { type: 'turn_finished', durationMs: 50 },
            ]);
        expect(threadStart?.params)
            .toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'workspace-write', developerInstructions: 'You are Ana.' });
        expect(turnStart?.params)
            .toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello', text_elements: [] }] });
        expect(spawnOptions[0]?.env)
            .toEqual({ PATH: '/usr/bin', HOME: `${home}-home`, CODEX_HOME: home });
    });

    it.skipIf(process.platform === 'win32')('makes the Codex home and the user home for the owner only', async () => {
        const { engine, home } = makeEngine(completeTurn);

        await collect(engine.runTurn(makeRequest()));

        expect(statSync(home).mode & 0o777)
            .toBe(0o700);
        expect(statSync(`${home}-home`).mode & 0o777)
            .toBe(0o700);
    });

    it('keeps the Codex home and the user home when the environment and the turn set them too', async () => {
        const { engine, spawnOptions, home } = makeEngine(completeTurn, { environment: { PATH: '/usr/bin', HOME: '/root', CODEX_HOME: '/root' } });

        await collect(engine.runTurn(makeRequest({ extraEnvironment: { HOME: '/tmp', CODEX_HOME: '/tmp', TOKEN: 'x' } })));

        expect(spawnOptions[0]?.env)
            .toEqual({ PATH: '/usr/bin', HOME: `${home}-home`, CODEX_HOME: home, TOKEN: 'x' });
    });

    it('resumes the thread of an earlier turn', async () => {
        const { engine, servers } = makeEngine(completeTurn);

        const events = await collect(engine.runTurn(makeRequest({ sessionId: 'thread-7' })));
        const resume = servers[0]?.sent.find(message => message.method === 'thread/resume');

        expect(resume?.params)
            .toMatchObject({ threadId: 'thread-7', approvalPolicy: 'untrusted' });
        expect(events)
            .toContainEqual({ type: 'session', sessionId: 'thread-7' });
    });

    it('answers a command approval with the decision of the review', async () => {
        const review = vi.fn((): Promise<ToolCallDecision> => Promise.resolve({ isAllowed: false, reason: 'No.' }));
        const { engine, servers } = makeEngine((server) => {
            server.say({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'call_1', command: '/bin/bash -lc \'rm -rf build\'', status: 'inProgress', aggregatedOutput: null, exitCode: null } } });
            server.say({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { kind: 'command', itemId: 'call_1', command: '/bin/bash -lc \'rm -rf build\'' } });
            setTimeout(() => {
                completeTurn(server);
            }, 20);
        });

        await collect(engine.runTurn(makeRequest({ reviewToolCall: review })));
        const answer = servers[0]?.sent.find(message => (message as { id?: unknown }).id === 'approval-1');

        expect(review)
            .toHaveBeenCalledWith({ toolName: 'Bash', input: { command: 'rm -rf build' } }, expect.any(AbortSignal));
        expect(answer)
            .toMatchObject({ result: { decision: 'decline' } });
    });

    it('reviews the newest patch Codex sent for a file change', async () => {
        const review = vi.fn((): Promise<ToolCallDecision> => Promise.resolve({ isAllowed: true }));
        const { engine, servers } = makeEngine((server) => {
            server.say({ method: 'item/started', params: { item: { type: 'fileChange', id: 'call_2', status: 'inProgress', changes: [{ path: '/w/a.txt', kind: { type: 'add' }, diff: 'part' }] } } });
            server.say({ method: 'item/fileChange/patchUpdated', params: { itemId: 'call_2', changes: [{ path: '/w/a.txt', kind: { type: 'add' }, diff: 'full' }] } });
            server.say({ id: 'approval-1', method: 'item/fileChange/requestApproval', params: { itemId: 'call_2', reason: null, grantRoot: null } });
            setTimeout(() => {
                completeTurn(server);
            }, 20);
        });

        await collect(engine.runTurn(makeRequest({ reviewToolCall: review })));
        const answer = servers[0]?.sent.find(message => (message as { id?: unknown }).id === 'approval-1');

        expect(review)
            .toHaveBeenCalledWith({ toolName: 'Write', input: { file_path: '/w/a.txt', content: 'full' } }, expect.any(AbortSignal));
        expect(answer)
            .toMatchObject({ result: { decision: 'accept' } });
    });

    it('declines a patch inside the Codex home without a review', async () => {
        const review = vi.fn((): Promise<ToolCallDecision> => Promise.resolve({ isAllowed: true }));
        const { engine, servers, home } = makeEngine((server) => {
            server.say({ method: 'item/started', params: { item: { type: 'fileChange', id: 'call_2', status: 'inProgress', changes: [{ path: join(home, 'config.toml'), kind: { type: 'add' }, diff: 'x' }] } } });
            server.say({ id: 'approval-1', method: 'item/fileChange/requestApproval', params: { itemId: 'call_2', reason: null, grantRoot: null } });
            setTimeout(() => {
                completeTurn(server);
            }, 20);
        });

        await collect(engine.runTurn(makeRequest({ reviewToolCall: review })));
        const answer = servers[0]?.sent.find(message => (message as { id?: unknown }).id === 'approval-1');

        expect(review)
            .not.toHaveBeenCalled();
        expect(answer)
            .toMatchObject({ result: { decision: 'decline' } });
    });

    it('declines every call when the turn has no review', async () => {
        const { engine, servers } = makeEngine((server) => {
            server.say({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { kind: 'command', itemId: 'call_1', command: 'ls' } });
            setTimeout(() => {
                completeTurn(server);
            }, 20);
        });

        await collect(engine.runTurn(makeRequest()));
        const answer = servers[0]?.sent.find(message => (message as { id?: unknown }).id === 'approval-1');

        expect(answer)
            .toMatchObject({ result: { decision: 'decline' } });
    });

    it('interrupts the turn on a stop, yields no error and kills the process group', async () => {
        const controller = new AbortController();
        // The stop comes once the turn runs, after its id is known.
        const { engine, servers, signals } = makeEngine(() => {
            setTimeout(() => {
                controller.abort();
            }, 10);
        });

        const events = await collect(engine.runTurn(makeRequest({ abortSignal: controller.signal })));

        expect(servers[0]?.sent.some(message => message.method === 'turn/interrupt'))
            .toBe(true);
        expect(events.filter(event => event.type === 'turn_error'))
            .toEqual([]);
        expect(signals)
            .toEqual(process.platform === 'win32' ? [] : ['KILL']);
    });

    it('ends the process when the stop comes before the turn has an id', async () => {
        const controller = new AbortController();
        const { engine, signals } = makeEngine(() => {
            controller.abort();
        });

        const events = await collect(engine.runTurn(makeRequest({ abortSignal: controller.signal })));

        expect(events.filter(event => event.type === 'turn_error'))
            .toEqual([]);
        expect(signals)
            .toEqual(process.platform === 'win32' ? [] : ['KILL']);
    });

    it('reports a thread that cannot start as a turn error', async () => {
        const { engine } = makeEngine(completeTurn, { failThreadStart: true });
        const consoleError = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);

        const events = await collect(engine.runTurn(makeRequest()));

        expect(significant(events))
            .toEqual([{ type: 'turn_error', message: 'Codex could not start the turn.', isUsageLimit: false }]);
        consoleError.mockRestore();
    });

    it('reports an exit before the turn ended as a turn error', async () => {
        const { engine } = makeEngine((server) => {
            server.exit();
        });

        const events = await collect(engine.runTurn(makeRequest()));

        expect(events.at(-1))
            .toEqual({ type: 'turn_error', message: 'Codex stopped before the turn ended.', isUsageLimit: false });
    });

    it('stops the turn past the step limit', async () => {
        const { engine, servers } = makeEngine((server) => {
            ['a', 'b'].forEach((id) => {
                server.say({ method: 'item/started', params: { item: { type: 'commandExecution', id, command: 'ls', status: 'inProgress', aggregatedOutput: null, exitCode: null } } });
            });
        });

        const events = await collect(engine.runTurn(makeRequest({ maxSteps: 1 })));

        expect(events.at(-1))
            .toEqual({ type: 'turn_limit', limit: 'steps' });
        expect(servers)
            .toHaveLength(1);
    });

    it('declines a command asked for past the step limit, before it runs', async () => {
        const review = vi.fn((): Promise<ToolCallDecision> => Promise.resolve({ isAllowed: true }));
        const { engine, servers } = makeEngine((server) => {
            server.say({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { kind: 'command', itemId: 'a', command: 'ls', cwd: tmpdir() } });
            server.say({ id: 'approval-2', method: 'item/commandExecution/requestApproval', params: { kind: 'command', itemId: 'b', command: 'ls', cwd: tmpdir() } });
        });

        // The fake never ends the turn, so only the step limit can end it.
        const events = await collect(engine.runTurn(makeRequest({ maxSteps: 1, reviewToolCall: review })));
        const answers = servers[0]?.sent.filter(message => typeof (message as { id?: unknown }).id === 'string');

        // The turn ends at the second ask, so its input may close before every answer is written. It is never accepted.
        expect(answers)
            .not.toContainEqual({ jsonrpc: '2.0', id: 'approval-2', result: { decision: 'accept' } });
        expect(review)
            .toHaveBeenCalledTimes(1);
        expect(events.at(-1))
            .toEqual({ type: 'turn_limit', limit: 'steps' });
    });

    it('refuses images without starting Codex', async () => {
        const { engine, servers } = makeEngine(completeTurn);

        const events = await collect(engine.runTurn(makeRequest({ images: [{ mediaType: 'image/png', data: 'AAAA' }] })));

        expect(events)
            .toEqual([{ type: 'turn_error', message: 'This bot runs on Codex, which cannot read images in CloudBot yet.', isUsageLimit: false }]);
        expect(servers)
            .toHaveLength(0);
    });
});
