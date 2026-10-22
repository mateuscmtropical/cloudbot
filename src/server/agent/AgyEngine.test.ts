import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

import type { AgentEvent } from './AgentEvent.ts';
import type { ToolCall, ToolCallDecision } from './AgentRunner.ts';
import { AgyEngine, toAgyModel } from './AgyEngine.ts';
import type { LoopbackToolServer, LoopbackTurnGrant } from './createLoopbackToolServer.ts';

class FakeAgy extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    pid = 4242;
}

interface Fixture {
    engine: AgyEngine;
    agy: FakeAgy;
    environments: Record<string, string>[];
    grants: LoopbackTurnGrant[];
    signals: string[];
}

function makeEngine(): Fixture {
    const agy = new FakeAgy();
    const environments: Record<string, string>[] = [];
    const grants: LoopbackTurnGrant[] = [];
    const signals: string[] = [];
    const loopback: LoopbackToolServer = {
        grantTurn: (grant) => {
            grants.push(grant);

            return {
                folder: '/tmp', mcpConfigPath: '', settingsPath: '', mcpUrl: 'http://127.0.0.1:4100/mcp', token: 'a'.repeat(64),
                noteToolUse: () => undefined, writeFile: () => '', allowCall: () => undefined, release: () => undefined,
            };
        },
        close: () => Promise.resolve(),
    };
    const engine = new AgyEngine({
        label: 'Gemini', command: '/usr/local/bin/cloudbot-provider', args: ['gemini', 'agy'], loopback, protectedFolders: ['.gemini', '.agents'],
        launch: {
            spawnFunction: (_command, _args, options) => {
                environments.push(options.env as Record<string, string>);

                return agy as unknown as ChildProcess;
            },
            signalProcess: (_child, action) => {
                signals.push(action);
            },
        },
    });

    return { engine, agy, environments, grants, signals };
}

describe('toAgyModel', () => {
    it('passes only Gemini slugs and adds the level from the effort', () => {
        expect(toAgyModel('opus', 'low'))
            .toBeUndefined();
        expect(toAgyModel('gemini-3.8-flash', 'low'))
            .toBe('gemini-3.8-flash-low');
        expect(toAgyModel('gemini-3.8-flash', 'max'))
            .toBe('gemini-3.8-flash-high');
        expect(toAgyModel('gemini-3.8-flash-medium', 'low'))
            .toBe('gemini-3.8-flash-medium');
        expect(toAgyModel('gemini-3.8-flash', undefined))
            .toBe('gemini-3.8-flash');
    });
});

// prepareAgentWorkspace changes folder modes, which Windows refuses. CI runs on Linux.
describe.skipIf(process.platform === 'win32')('AgyEngine', () => {
    let workspaceDir: string;

    beforeEach(async () => {
        workspaceDir = await mkdtemp(join(tmpdir(), 'cloudbot-agy-'));
    });

    afterEach(async () => {
        await rm(workspaceDir, { recursive: true, force: true });
    });

    it('sends the prompt and maps the stream to chat events', async () => {
        const { engine, agy, environments, signals } = makeEngine();
        const written: string[] = [];

        agy.stdin.on('data', (chunk: Buffer) => {
            written.push(chunk.toString('utf8'));
        });

        const sessionId = '18a96424-429a-4c7c-9ac0-08967cd7d51a';
        const tool = { name: 'models_set', description: 'Sets models.', inputSchema: { chat: z.string() }, handler: () => Promise.resolve({ content: [] }) };
        const turn = engine.runTurn({ botId: 'bot', workspaceDir, prompt: 'Hi', sessionId, model: 'opus', effort: 'low', tools: [tool], abortSignal: new AbortController().signal });
        const events: AgentEvent[] = [];
        const reading = (async () => {
            // The events are an async iterator, so `for await` is the only loop form that fits.
            for await (const event of turn) {
                events.push(event);
            }
        })();

        await vi.waitFor(() => {
            expect(environments)
                .toHaveLength(1);
        });
        const lines = [
            { event: 'init', conversation_id: sessionId, init: {} },
            { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } } },
            { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_info: { name: 'run_command', output: 'a.txt' } } },
            { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Do' } },
            { event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'ne' } },
            { event: 'result', result: { status: 'SUCCESS', response: 'Done' } },
        ];

        agy.stdout.end(lines.map(line => `${JSON.stringify(line)}\n`)
            .join(''));
        await reading;

        const sent = JSON.parse(written.join('')) as { message: { content: { text: string }[] } };

        // agy does not see the argument names of MCP tools, so the prompt lists them before the owner's message.
        expect(sent.message.content[0]?.text)
            .toMatch(/- models_set\(chat\)\n\nHi$/);
        expect(environments[0])
            .toMatchObject({ CLOUDBOT_AGY_CONVERSATION: sessionId, CLOUDBOT_AGY_EFFORT: 'low', CLOUDBOT_AGY_REVIEW_URL: 'http://127.0.0.1:4100/mcp' });
        // A Claude model name is not an agy model, so it is not passed.
        expect(environments[0])
            .not.toHaveProperty('CLOUDBOT_AGY_MODEL');
        expect(events)
            .toEqual([
                { type: 'session', sessionId },
                { type: 'tool_started', toolUseId: 'agy-2', toolName: 'run_command', input: { CommandLine: 'ls' } },
                { type: 'tool_finished', toolUseId: 'agy-2', isError: false, output: 'a.txt' },
                { type: 'text_delta', text: 'Do' },
                { type: 'text_delta', text: 'ne' },
                // The full text is sent once the step is done, so the chat saves it.
                { type: 'text', text: 'Done' },
                { type: 'turn_finished' },
            ]);
        expect(signals)
            .toContain('KILL');
    });

    it('reviews agy tools as CloudBot calls and refuses its own services and protected folders', async () => {
        const { engine, agy, grants } = makeEngine();
        const reviewed: ToolCall[] = [];
        const reviewToolCall = (call: ToolCall): Promise<ToolCallDecision> => {
            reviewed.push(call);

            return Promise.resolve({ isAllowed: true });
        };
        const turn = engine.runTurn({ botId: 'bot', workspaceDir, prompt: 'Hi', reviewToolCall, abortSignal: new AbortController().signal });
        const reading = (async () => {
            // The events are an async iterator, so `for await` is the only loop form that fits.
            for await (const event of turn) {
                expect(event)
                    .toBeDefined();
            }
        })();

        await vi.waitFor(() => {
            expect(grants)
                .toHaveLength(1);
        });
        const review = grants[0]!.reviewToolCall;
        const signal = new AbortController().signal;

        expect(await review({ toolName: 'run_command', input: { CommandLine: 'ls -la' } }, signal))
            .toEqual({ isAllowed: true });
        expect(await review({ toolName: 'write_file', input: { Path: '/w/notes.txt', Content: 'hi' } }, signal))
            .toEqual({ isAllowed: true });
        expect(await review({ toolName: 'schedule', input: {} }, signal))
            .toMatchObject({ isAllowed: false });
        expect(await review({ toolName: 'write_file', input: { Path: '/w/.agents/hooks.json', Content: '{}' } }, signal))
            .toMatchObject({ isAllowed: false });
        expect(reviewed.map(call => call.toolName))
            .toEqual(['Bash', 'Write']);
        expect(reviewed[0]?.input)
            .toEqual({ command: 'ls -la' });
        expect(reviewed[1]?.input)
            .toHaveProperty('file_path', '/w/notes.txt');

        agy.stdout.end();
        await reading;
    });

    it('says the provider is not signed in when agy ends asking for a sign-in', async () => {
        const { engine, agy } = makeEngine();
        const turn = engine.runTurn({ botId: 'bot', workspaceDir, prompt: 'Hi', abortSignal: new AbortController().signal });
        const events: AgentEvent[] = [];
        const reading = (async () => {
            // The events are an async iterator, so `for await` is the only loop form that fits.
            for await (const event of turn) {
                events.push(event);
            }
        })();

        await vi.waitFor(() => {
            expect(agy.listenerCount('error'))
                .toBeGreaterThan(0);
        });
        agy.stderr.write('Error: authentication required. Run \'agy\' to log in, then retry.\n');
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
        agy.stdout.end();
        await reading;

        expect(events)
            .toEqual([{ type: 'turn_error', message: 'Gemini is not signed in. Ask me to connect Gemini.', isUsageLimit: false }]);
    });
});
