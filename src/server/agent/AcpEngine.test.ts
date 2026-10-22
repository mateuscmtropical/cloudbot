import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { AcpEngine, namesProtectedFolder, toReviewedCall } from './AcpEngine.ts';
import type { AgentEvent } from './AgentEvent.ts';
import type { ToolCallDecision, TurnRequest } from './AgentRunner.ts';

interface SentMessage {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code?: number };
}

interface FakeOptions {
    capabilities?: Record<string, unknown>;
    failAuthenticate?: boolean;
    failNewSession?: string;
    onPrompt?: (agent: FakeAcpAgent, promptId: number) => void;
}

// A stand-in for an ACP agent such as `gemini --experimental-acp`. It answers the setup calls, then plays the prompt.
class FakeAcpAgent extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly sent: SentMessage[] = [];
    pid = 4343;
    private readonly options: FakeOptions;

    constructor(options: FakeOptions) {
        super();
        this.options = options;
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
        this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message as object })}\n`);
    }

    update(update: Record<string, unknown>): void {
        this.say({ method: 'session/update', params: { sessionId: 'session-1', update } });
    }

    exit(): void {
        if (!this.stdout.writableEnded) {
            this.stdout.end();
            this.emit('exit', 0);
        }
    }

    // Waits for the client to answer a request the agent sent.
    answerTo(id: number): Promise<SentMessage> {
        return vi.waitFor(() => {
            const found = this.sent.find(message => message.id === id && message.method === undefined);

            if (found === undefined) {
                throw new Error('not answered yet');
            }

            return found;
        });
    }

    private receive(message: SentMessage): void {
        this.sent.push(message);

        if (message.method === 'initialize') {
            this.say({ id: message.id, result: { protocolVersion: 1, agentCapabilities: this.options.capabilities ?? { mcpCapabilities: { http: true } } } });
        }

        if (message.method === 'authenticate') {
            this.say(this.options.failAuthenticate === true ? { id: message.id, error: { code: -32000, message: 'Authentication required' } } : { id: message.id, result: {} });
        }

        if (message.method === 'session/new') {
            if (this.options.failNewSession !== undefined) {
                this.say({ id: message.id, error: { code: -32000, message: this.options.failNewSession } });

                return;
            }

            this.say({ id: message.id, result: { sessionId: 'session-1' } });
        }

        if (message.method === 'session/set_mode') {
            this.say({ id: message.id, result: {} });
        }

        if (message.method === 'session/load') {
            this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } });
            this.say({ id: message.id, result: {} });
        }

        if (message.method === 'session/prompt' && message.id !== undefined) {
            const promptId = message.id;

            if (this.options.onPrompt === undefined) {
                this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } });
                this.say({ id: promptId, result: { stopReason: 'end_turn' } });

                return;
            }

            this.options.onPrompt(this, promptId);
        }
    }
}

function makeEngine(options: FakeOptions = {}, authMethodId?: string, askModeId?: string): { engine: AcpEngine; agents: FakeAcpAgent[] } {
    const agents: FakeAcpAgent[] = [];
    const home = join(mkdtempSync(join(tmpdir(), 'cloudbot-acp-test-')), 'home');
    const engine = new AcpEngine({
        label: 'Gemini',
        command: '/usr/local/bin/gemini',
        args: ['--experimental-acp'],
        homeFor: () => home,
        authMethodId,
        askModeId,
        spawnFunction: () => {
            const agent = new FakeAcpAgent(options);

            agents.push(agent);

            return agent as unknown as ChildProcess;
        },
        signalProcess: () => undefined,
    });

    return { engine, agents };
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

function askPermission(agent: FakeAcpAgent, id: number, toolCall: Record<string, unknown>): void {
    agent.say({
        id,
        method: 'session/request_permission',
        params: {
            sessionId: 'session-1',
            toolCall,
            options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
        },
    });
}

describe('AcpEngine', () => {
    it('streams the reply and offers no file system or terminal', async () => {
        const { engine, agents } = makeEngine();

        const events = await collect(engine.runTurn(makeRequest()));
        const initialize = agents[0]?.sent.find(message => message.method === 'initialize');

        expect(events)
            .toEqual([{ type: 'session', sessionId: 'session-1' }, { type: 'text_delta', text: 'Hi' }, { type: 'turn_finished' }]);
        expect(initialize?.params?.clientCapabilities)
            .toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    });

    it('sends each permission question to the review and answers with a single use option', async () => {
        const reviewToolCall = vi.fn((call: { toolName: string }): Promise<ToolCallDecision> => Promise.resolve(call.toolName === 'Bash' ? { isAllowed: true } : { isAllowed: false, reason: 'no' }));
        const answers: SentMessage[] = [];
        const { engine } = makeEngine({
            onPrompt: (agent, promptId) => {
                askPermission(agent, 900, { toolCallId: 't1', kind: 'execute', title: 'ls', rawInput: { command: 'ls -la' } });
                askPermission(agent, 901, { toolCallId: 't2', kind: 'fetch', title: 'https://example.com', rawInput: { url: 'https://example.com' } });
                void Promise.all([agent.answerTo(900), agent.answerTo(901)])
                    .then((found) => {
                        answers.push(...found);
                        agent.say({ id: promptId, result: { stopReason: 'end_turn' } });
                    });
            },
        });

        await collect(engine.runTurn(makeRequest({ reviewToolCall })));

        expect(reviewToolCall.mock.calls.map(call => call[0]))
            .toEqual([{ toolName: 'Bash', input: { command: 'ls -la' } }, { toolName: 'WebFetch', input: { url: 'https://example.com' } }]);
        expect(answers.map(answer => answer.result))
            .toEqual([{ outcome: { outcome: 'selected', optionId: 'yes' } }, { outcome: { outcome: 'selected', optionId: 'no' } }]);
    });

    it('refuses a client method it does not offer', async () => {
        let answer: SentMessage | undefined;
        const { engine } = makeEngine({
            onPrompt: (agent, promptId) => {
                agent.say({ id: 902, method: 'fs/read_text_file', params: { sessionId: 'session-1', path: '/etc/passwd' } });
                void agent.answerTo(902)
                    .then((found) => {
                        answer = found;
                        agent.say({ id: promptId, result: { stopReason: 'end_turn' } });
                    });
            },
        });

        await collect(engine.runTurn(makeRequest()));

        expect(answer?.error?.code)
            .toBe(-32601);
    });

    it('loads an earlier session and drops the replayed history', async () => {
        const { engine, agents } = makeEngine({ capabilities: { loadSession: true } });

        const events = await collect(engine.runTurn(makeRequest({ sessionId: 'session-1' })));

        expect(agents[0]?.sent.some(message => message.method === 'session/new'))
            .toBe(false);
        expect(events)
            .toEqual([{ type: 'session', sessionId: 'session-1' }, { type: 'text_delta', text: 'Hi' }, { type: 'turn_finished' }]);
    });

    it('refuses calls over the step limit and stops the turn', async () => {
        const reviewToolCall = vi.fn((): Promise<ToolCallDecision> => Promise.resolve({ isAllowed: true }));
        const answers: SentMessage[] = [];
        const { engine } = makeEngine({
            onPrompt: (agent, promptId) => {
                askPermission(agent, 903, { toolCallId: 't1', kind: 'read', locations: [{ path: '/work/a' }] });
                askPermission(agent, 904, { toolCallId: 't2', kind: 'read', locations: [{ path: '/work/b' }] });
                void Promise.all([agent.answerTo(903), agent.answerTo(904)])
                    .then((found) => {
                        answers.push(...found);
                        agent.say({ id: promptId, result: { stopReason: 'cancelled' } });
                    });
            },
        });

        const events = await collect(engine.runTurn(makeRequest({ reviewToolCall, maxSteps: 1 })));

        expect(reviewToolCall)
            .toHaveBeenCalledOnce();
        expect(answers[1]?.result)
            .toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
        expect(events)
            .toContainEqual({ type: 'turn_limit', limit: 'steps' });
    });

    it('asks the owner to connect the provider when the agent is not signed in', async () => {
        const { engine } = makeEngine({ failNewSession: 'Authentication required' });

        const events = await collect(engine.runTurn(makeRequest()));

        expect(events)
            .toEqual([{ type: 'turn_error', message: 'Gemini is not signed in. Ask me to connect Gemini.', isUsageLimit: false }]);
    });

    it('authenticates with the cached sign-in before the session when the agent needs it', async () => {
        const { engine, agents } = makeEngine({}, 'cursor_login');

        await collect(engine.runTurn(makeRequest()));

        expect(agents[0]?.sent.map(message => message.method))
            .toEqual(['initialize', 'authenticate', 'session/new', 'session/prompt']);
    });

    it('switches the session to the mode that asks before each tool, before the prompt', async () => {
        const { engine, agents } = makeEngine({}, undefined, 'ask');

        await collect(engine.runTurn(makeRequest()));
        const setMode = agents[0]?.sent.find(message => message.method === 'session/set_mode');

        expect(agents[0]?.sent.map(message => message.method))
            .toEqual(['initialize', 'session/new', 'session/set_mode', 'session/prompt']);
        expect(setMode?.params)
            .toEqual({ sessionId: 'session-1', modeId: 'ask' });
    });

    it('tells whether the sign-in works without sending a prompt', async () => {
        const signedIn = makeEngine({}, 'cursor_login');
        const signedOut = makeEngine({ failAuthenticate: true }, 'cursor_login');
        const broken = makeEngine({ failNewSession: 'disk full' });

        expect(await signedIn.engine.isSignedIn('bot-1', tmpdir()))
            .toBe(true);
        expect(signedIn.agents[0]?.sent.some(message => message.method === 'session/prompt'))
            .toBe(false);
        expect(await signedOut.engine.isSignedIn('bot-1', tmpdir()))
            .toBe(false);
        expect(await broken.engine.isSignedIn('bot-1', tmpdir()))
            .toBeUndefined();
    });

    it('finds a protected sign-in or config folder in a question', () => {
        const folders = ['/home/bot/.copilot', '.gemini'];

        expect(namesProtectedFolder({ kind: 'execute', rawInput: { command: 'cat /home/bot/.copilot/config.json' } }, folders))
            .toBe(true);
        expect(namesProtectedFolder({ kind: 'edit', locations: [{ path: '/work/.gemini/settings.json' }] }, folders))
            .toBe(true);
        expect(namesProtectedFolder({ kind: 'execute', rawInput: { command: 'echo .geminis' } }, folders))
            .toBe(false);
    });

    it('maps each ACP tool kind to the CloudBot rule that reviews it', () => {
        expect(toReviewedCall({ kind: 'edit', locations: [{ path: '/work/x.ts' }], rawInput: { content: 'a' } }))
            .toEqual({ toolName: 'Write', input: { content: 'a', file_path: '/work/x.ts' } });
        expect(toReviewedCall({ kind: 'think', name: 'plan', title: 'Plan' }))
            .toEqual({ toolName: 'acp__plan', input: { title: 'Plan', input: {} } });
    });
});
