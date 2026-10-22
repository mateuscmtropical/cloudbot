import { spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './AgentEvent.ts';
import type { TurnRequest } from './AgentRunner.ts';
import { buildCliArguments, buildUserMessage, ClaudeCliEngine, noProxyValues } from './ClaudeCliEngine.ts';
import type { SpawnFunction } from './ClaudeCliEngine.ts';
import { buildCliDisallowedTools } from './buildCliDisallowedTools.ts';
import type { LoopbackToolServer, LoopbackTurn, LoopbackTurnGrant } from './createLoopbackToolServer.ts';
import { mapCliMessage } from './mapCliMessage.ts';
import type { CliMessage } from './mapCliMessage.ts';

const FIXTURE_FOLDER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-stream');

// A child process stand-in. The test decides what stdout says and how the process ends.
class FakeChild extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
}

interface FakeScript {
    stdout: string;
    exitCode: number | null;
    spawnError?: Error;
    // A hanging child never answers on its own. Only a stop ends it.
    hangs?: boolean;
}

// Signal 0 checks that the process exists without touching it. A killed process whose parent already exited may wait as a
// zombie until init reaps it, and some containers never do, so on Linux a zombie counts as gone.
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
    } catch {
        return false;
    }

    const statPath = `/proc/${String(pid)}/stat`;

    if (!existsSync(statPath)) {
        return true;
    }

    const stat = readFileSync(statPath, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);

    return state !== 'Z';
}

function fixture(name: string): string {
    return readFileSync(join(FIXTURE_FOLDER, `${name}.jsonl`), 'utf8');
}

function makeLoopback(): { loopback: LoopbackToolServer; grants: LoopbackTurnGrant[]; released: () => number; notes: string[] } {
    const folder = mkdtempSync(join(tmpdir(), 'cloudbot-engine-test-'));
    const grants: LoopbackTurnGrant[] = [];
    const notes: string[] = [];
    let releases = 0;
    const turn: LoopbackTurn = {
        folder,
        mcpConfigPath: join(folder, 'mcp.json'),
        settingsPath: join(folder, 'settings.json'),
        noteToolUse(toolUseId: string, toolName: string): void {
            notes.push(`${toolUseId}:${toolName}`);
        },
        writeFile(name: string): string {
            return join(folder, name);
        },
        allowCall: () => undefined,
        mcpUrl: 'http://127.0.0.1:1/mcp',
        token: 'fake-token',
        release(): void {
            releases += 1;
        },
    };
    const loopback: LoopbackToolServer = {
        grantTurn(grant: LoopbackTurnGrant): LoopbackTurn {
            grants.push(grant);

            return turn;
        },
        close: () => Promise.resolve(),
    };

    return { loopback, grants, released: () => releases, notes };
}

function makeRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
    return {
        botId: 'bot-1',
        workspaceDir: tmpdir(),
        prompt: 'say hello',
        abortSignal: new AbortController().signal,
        ...overrides,
    };
}

// The fake child replies on the next tick, after the engine has attached its listeners.
function scriptedSpawn(script: FakeScript): { spawn: SpawnFunction; children: FakeChild[] } {
    const children: FakeChild[] = [];
    const spawn: SpawnFunction = vi.fn(() => {
        const child = new FakeChild();

        children.push(child);

        if (script.hangs) {
            return child as unknown as ChildProcess;
        }

        setImmediate(() => {
            if (script.spawnError) {
                child.emit('error', script.spawnError);

                return;
            }

            child.stdout.end(script.stdout);
            child.emit('exit', script.exitCode);
        });

        return child as unknown as ChildProcess;
    });

    return { spawn, children };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const collected: AgentEvent[] = [];

    for await (const event of events) {
        collected.push(event);
    }

    return collected;
}

// Activity and session events are not shown as rows, so the expectations leave them out.
function significant(events: AgentEvent[]): AgentEvent[] {
    return events.filter(event => event.type !== 'activity' && event.type !== 'session');
}

describe('buildCliArguments', () => {
    const files = { mcpConfigPath: '/t/mcp.json', settingsPath: '/t/settings.json' };

    it('runs stream-json headless with the MCP config and the permission settings as files', () => {
        const args = buildCliArguments(makeRequest(), files);

        expect(args.slice(0, 7))
            .toEqual([
                '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
            ]);
        expect(args)
            .toContain('--strict-mcp-config');
        expect(args[args.indexOf('--mcp-config') + 1])
            .toBe('/t/mcp.json');
        expect(args[args.indexOf('--settings') + 1])
            .toBe('/t/settings.json');
    });

    it('adds resume, model, effort and the bot profile only when the request sets them', () => {
        const bare = buildCliArguments(makeRequest(), files);
        const full = buildCliArguments(makeRequest({
            sessionId: 'sess-1',
            model: 'haiku',
            effort: 'high',
            systemPrompt: 'You are the bot.',
            agents: {},
            maxSteps: 4,
            maxSpendUsd: 1.5,
        }), { ...files, systemPromptPath: '/t/system-prompt.txt', agentsPath: '/t/agents.json' });

        expect(bare).not.toContain('--resume');
        expect(bare).not.toContain('--model');
        expect(full.slice(full.indexOf('--resume'), full.indexOf('--resume') + 2))
            .toEqual(['--resume', 'sess-1']);
        expect(full.slice(full.indexOf('--model'), full.indexOf('--model') + 2))
            .toEqual(['--model', 'haiku']);
        expect(full.slice(full.indexOf('--effort'), full.indexOf('--effort') + 2))
            .toEqual(['--effort', 'high']);
        // The long texts go in files, so no argv grows with the prompt or the agent list.
        expect(full.slice(full.indexOf('--append-system-prompt-file'), full.indexOf('--append-system-prompt-file') + 2))
            .toEqual(['--append-system-prompt-file', '/t/system-prompt.txt']);
        expect(full).not.toContain('--append-system-prompt');
        expect(full.slice(full.indexOf('--agents'), full.indexOf('--agents') + 2))
            .toEqual(['--agents', '/t/agents.json']);
        expect(full.slice(full.indexOf('--max-turns'), full.indexOf('--max-turns') + 2))
            .toEqual(['--max-turns', '4']);
        expect(full.slice(full.indexOf('--max-budget-usd'), full.indexOf('--max-budget-usd') + 2))
            .toEqual(['--max-budget-usd', '1.5']);
    });

    it('puts the variadic lists last so the next flag ends them', () => {
        const args = buildCliArguments(makeRequest({
            disallowedTools: ['Bash'],
            additionalDirectories: ['/uploads'],
        }), files);
        const disallowedToolIndex = args.indexOf('--disallowedTools');
        const addDirectoryIndex = args.indexOf('--add-dir');

        expect(args.slice(disallowedToolIndex, addDirectoryIndex))
            .toEqual(['--disallowedTools', 'mcp__cloudbot__approve', ...buildCliDisallowedTools(['Bash'])]);
        expect(args.slice(addDirectoryIndex))
            .toEqual(['--add-dir', '/uploads']);
    });

    it('lists only the built-in tools the server knows, and hides the prompt tool from the model', () => {
        const args = buildCliArguments(makeRequest(), files);
        const tools = args[args.indexOf('--tools') + 1] ?? '';
        const disallowedToolIndex = args.indexOf('--disallowedTools');

        expect(tools.split(','))
            .toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Task', 'WebFetch', 'WebSearch', 'Write']);
        expect(args.slice(disallowedToolIndex + 1))
            .toEqual(['mcp__cloudbot__approve', ...buildCliDisallowedTools([])]);
    });

    it('sends every call through the permission prompt tool and loads no user or project settings', () => {
        const args = buildCliArguments(makeRequest(), files);

        expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2))
            .toEqual(['--setting-sources', '']);
        expect(args.slice(args.indexOf('--permission-prompt-tool'), args.indexOf('--permission-prompt-tool') + 2))
            .toEqual(['--permission-prompt-tool', 'mcp__cloudbot__approve']);
        expect(args).not.toContain('--allowedTools');
        expect(args).not.toContain('--agents');
        expect(args).not.toContain('--append-system-prompt-file');
    });

    it('adds the loopback addresses to NO_PROXY and no_proxy after the values the server has', () => {
        expect(noProxyValues({ NO_PROXY: 'corp.example', no_proxy: undefined }))
            .toEqual({ NO_PROXY: 'corp.example,127.0.0.1,localhost', no_proxy: 'corp.example,127.0.0.1,localhost' });
        expect(noProxyValues({}))
            .toEqual({ NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
    });
});

describe('buildUserMessage', () => {
    it('sends the prompt as one text message on a line', () => {
        const text = buildUserMessage(makeRequest({ prompt: 'hi' }));
        const message = JSON.parse(text) as unknown;

        expect(message)
            .toEqual({ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null });
    });

    it('adds images as base64 blocks after the text', () => {
        const text = buildUserMessage(makeRequest({
            prompt: 'look',
            images: [{ mediaType: 'image/png', data: 'AAAA' }],
        }));
        const sent = JSON.parse(text) as { message: { content: unknown } };

        expect(sent.message.content)
            .toEqual([
                { type: 'text', text: 'look' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ]);
    });
});

describe('ClaudeCliEngine event mapping on recorded stream-json', () => {
    it('streams the text of a plain turn and reports the session', async () => {
        const { loopback } = makeLoopback();
        const { spawn } = scriptedSpawn({ stdout: fixture('text'), exitCode: 0 });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        const events = await collect(engine.runTurn(makeRequest()));
        const deltas = events.flatMap(event => (event.type === 'text_delta' ? [event.text] : []));
        const texts = events.flatMap(event => (event.type === 'text' ? [event.text] : []));

        expect(events)
            .toContainEqual({ type: 'session', sessionId: 'e2bfe1f0-c4e7-4564-8838-428321ab79ec' });
        expect(deltas.join(''))
            .toBe('Hello world.');
        expect(texts)
            .toEqual(['Hello world.']);
        expect(significant(events)
            .at(-1))
            .toMatchObject({ type: 'turn_finished' });
    });

    it('shows a tool call as one started and one finished row with the MCP name', async () => {
        const { loopback } = makeLoopback();
        const { spawn } = scriptedSpawn({ stdout: fixture('tool'), exitCode: 0 });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        const events = significant(await collect(engine.runTurn(makeRequest())));

        expect(events)
            .toContainEqual({ type: 'tool_started', toolUseId: 'toolu_rec1', toolName: 'mcp__cloudbot__echo', input: { text: 'hi' } });
        expect(events)
            .toContainEqual({ type: 'tool_finished', toolUseId: 'toolu_rec1', isError: false, output: 'echo hi' });
        expect(events.at(-1))
            .toMatchObject({ type: 'turn_finished' });
    });

    it('turns the step limit result into a turn_limit event', async () => {
        const { loopback } = makeLoopback();
        const { spawn } = scriptedSpawn({ stdout: fixture('max-turns'), exitCode: 1 });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        const events = significant(await collect(engine.runTurn(makeRequest({ maxSteps: 1 }))));

        expect(events.at(-1))
            .toEqual({ type: 'turn_limit', limit: 'steps' });
        expect(events.some(event => event.type === 'turn_error'))
            .toBe(false);
    });

    it('reports the usage limit text as the CLI wrote it', async () => {
        const { loopback } = makeLoopback();
        const { spawn } = scriptedSpawn({ stdout: fixture('usage-limit'), exitCode: 1 });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        const events = significant(await collect(engine.runTurn(makeRequest())));

        // The recorded result has api_error_status 429, and its text starts with the CLI's API error line.
        expect(events)
            .toEqual([{
                type: 'turn_error',
                message: 'API Error: Request rejected (429) · You\'ve hit your limit · resets 5pm (Europe/Lisbon)',
                isUsageLimit: true,
            }]);
    });

    it('detects a usage limit from the text alone when the CLI gives no status', () => {
        const events = mapCliMessage({
            type: 'result',
            subtype: 'success',
            is_error: true,
            result: 'API Error: Request rejected (429) · You\'ve hit your limit · resets 5pm (Europe/Lisbon)',
        } as unknown as CliMessage);

        expect(events)
            .toEqual([{
                type: 'turn_error',
                message: 'API Error: Request rejected (429) · You\'ve hit your limit · resets 5pm (Europe/Lisbon)',
                isUsageLimit: true,
            }]);
    });

    it('reports the logged-out state as the CLI wrote it, without starting a sign-in', async () => {
        const { loopback } = makeLoopback();
        const { spawn } = scriptedSpawn({ stdout: fixture('not-logged-in'), exitCode: 1 });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        const events = significant(await collect(engine.runTurn(makeRequest())));

        expect(events)
            .toEqual([{ type: 'turn_error', message: 'Not logged in · Please run /login', isUsageLimit: false }]);
    });
});

describe('ClaudeCliEngine process handling', () => {
    it('reports an exit without a result as a turn error and releases the turn', async () => {
        const { loopback, released } = makeLoopback();
        const { spawn } = scriptedSpawn({ stdout: '', exitCode: 1 });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        const events = await collect(engine.runTurn(makeRequest()));

        expect(events)
            .toEqual([{ type: 'turn_error', message: 'The Claude CLI stopped before the turn ended.', isUsageLimit: false }]);
        expect(released())
            .toBe(1);
    });

    it('reports a spawn failure as a turn error without hanging', async () => {
        const { loopback } = makeLoopback();
        const { spawn } = scriptedSpawn({ stdout: '', exitCode: null, spawnError: new Error('spawn claude ENOENT') });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        const events = await collect(engine.runTurn(makeRequest()));

        expect(events)
            .toEqual([{ type: 'turn_error', message: 'Could not start the Claude CLI. Check the server setup.', isUsageLimit: false }]);
    });

    it('reports a clean exit without a result as a turn error', async () => {
        const { loopback } = makeLoopback();
        const { spawn } = scriptedSpawn({ stdout: '', exitCode: 0 });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        const events = await collect(engine.runTurn(makeRequest()));

        expect(events)
            .toEqual([{ type: 'turn_error', message: 'The Claude CLI stopped before the turn ended.', isUsageLimit: false }]);
    });

    it('reports a spawn failure as a turn error without hanging', async () => {
        const { loopback } = makeLoopback();
        const { spawn } = scriptedSpawn({ stdout: '', exitCode: null, spawnError: new Error('spawn claude ENOENT') });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        const events = await collect(engine.runTurn(makeRequest()));

        expect(events)
            .toEqual([{ type: 'turn_error', message: 'Could not start the Claude CLI. Check the server setup.', isUsageLimit: false }]);
    });

    it('gives the turn a marker and ends what still carries it once the turn is over', async () => {
        const { loopback } = makeLoopback();
        const { spawn, children } = scriptedSpawn({ stdout: fixture('text'), exitCode: 0 });
        const ended: string[] = [];
        let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
        const recordingSpawn: SpawnFunction = (command, args, options) => {
            spawnedEnvironment = options.env;

            return spawn(command, args, options);
        };
        const engine = new ClaudeCliEngine({
            loopback,
            spawnFunction: recordingSpawn,
            environment: {},
            signalProcess: () => undefined,
            endLeftovers: (marker) => {
                ended.push(marker);
            },
        });

        await collect(engine.runTurn(makeRequest({ extraEnvironment: { CLOUDBOT_TURN_MARKER: 'from-the-request' } })));

        expect(children)
            .toHaveLength(1);
        expect(spawnedEnvironment?.CLOUDBOT_TURN_MARKER)
            .toMatch(/^[0-9a-f]{32}$/);
        expect(ended)
            .toEqual([spawnedEnvironment?.CLOUDBOT_TURN_MARKER]);
    });

    // The case of #165: an approved command starts a child in its own session, outside the CLI's group, and the turn
    // then ends normally. The child keeps the marker, so it is found and ended.
    it.skipIf(process.platform !== 'linux')('ends a command that left the process group, after a clean end of the turn', async () => {
        const { loopback } = makeLoopback();
        const folder = mkdtempSync(join(tmpdir(), 'cloudbot-leftover-test-'));
        const pidFile = join(folder, 'tool.pid');
        const fakeCli = [
            'const { spawn } = require("node:child_process");',
            'const { writeFileSync } = require("node:fs");',
            'const { createInterface } = require("node:readline");',
            'const say = (message) => process.stdout.write(JSON.stringify(message) + "\\n");',
            'createInterface({ input: process.stdin }).on("line", (line) => {',
            '    const message = JSON.parse(line);',
            '    if (message.type === "user") {',
            '        const tool = spawn("sleep", ["600"], { stdio: "ignore", detached: true });',
            '        tool.unref();',
            '        writeFileSync(process.env.FAKE_TOOL_PID_FILE, String(tool.pid));',
            '        say({ type: "system", subtype: "init", session_id: "s-1", tools: [], mcp_servers: [] });',
            '        say({ type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "s-1", total_cost_usd: 0, duration_ms: 1 });',
            '    }',
            '});',
            'process.stdin.on("end", () => process.exit(0));',
        ].join('\n');
        const realSpawn: SpawnFunction = (_command, args, options) => spawnProcess(process.execPath, ['-e', fakeCli, '--', ...args], options);
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: realSpawn, environment: { PATH: process.env.PATH ?? '', FAKE_TOOL_PID_FILE: pidFile } });

        const events = await collect(engine.runTurn(makeRequest()));
        const toolPid = Number(readFileSync(pidFile, 'utf8'));

        await vi.waitFor(() => {
            expect(isProcessAlive(toolPid))
                .toBe(false);
        });
        expect(events.filter(event => event.type === 'turn_error'))
            .toEqual([]);
    }, 15000);

    it('stops the CLI on abort with an interrupt on stdin, yields no error and releases the turn', async () => {
        const { loopback, released } = makeLoopback();
        const controller = new AbortController();
        const signals: string[] = [];
        const interrupts: string[] = [];
        const { spawn, children } = scriptedSpawn({ stdout: '', exitCode: null, hangs: true });
        const engine = new ClaudeCliEngine({
            loopback,
            spawnFunction: spawn,
            environment: {},
            signalProcess: (_child, action) => {
                signals.push(action);
            },
        });

        const eventsPromise = collect(engine.runTurn(makeRequest({ abortSignal: controller.signal })));

        // The engine reads the workspace memory before it spawns, so wait until the child exists, then abort.
        await vi.waitFor(() => {
            expect(children)
                .toHaveLength(1);
        });
        const child = children[0];

        // The fake CLI answers the interrupt by ending its output and exiting, as the real one does.
        child?.stdin.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');

            if (text.includes('control_request')) {
                interrupts.push(text);
                child.stdout.end();
                child.emit('exit', 0);
            }
        });
        controller.abort();
        const events = await eventsPromise;

        expect(children)
            .toHaveLength(1);
        expect(interrupts)
            .toHaveLength(1);
        expect(JSON.parse(interrupts[0] ?? '{}'))
            .toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
        // No TERM or KILL to the CLI itself. On POSIX the last KILL only clears the process group. On Windows nothing is sent after the exit.
        expect(signals)
            .toEqual(process.platform === 'win32' ? [] : ['KILL']);
        expect(events)
            .toEqual([]);
        expect(released())
            .toBe(1);
    });

    // A real process tree: a stand-in CLI starts a long command as its approved tool, then exits on the interrupt and leaves
    // the command running, as a CLI may do. The stop must still end that command.
    it.skipIf(process.platform === 'win32')('ends the turn on a stop during a running approved command, and the command is gone', async () => {
        const { loopback, released } = makeLoopback();
        const controller = new AbortController();
        const folder = mkdtempSync(join(tmpdir(), 'cloudbot-stop-test-'));
        const pidFile = join(folder, 'tool.pid');
        const fakeCli = [
            'const { spawn } = require("node:child_process");',
            'const { writeFileSync } = require("node:fs");',
            'const { createInterface } = require("node:readline");',
            'const say = (message) => process.stdout.write(JSON.stringify(message) + "\\n");',
            'createInterface({ input: process.stdin }).on("line", (line) => {',
            '    const message = JSON.parse(line);',
            '    if (message.type === "user") {',
            '        const tool = spawn("sleep", ["600"], { stdio: "ignore" });',
            '        writeFileSync(process.env.FAKE_TOOL_PID_FILE, String(tool.pid));',
            '        say({ type: "system", subtype: "init", session_id: "s-1", tools: [], mcp_servers: [] });',
            '        say({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_run", name: "Bash", input: { command: "sleep 600" } }] }, session_id: "s-1" });',
            '    }',
            '    if (message.type === "control_request") {',
            '        say({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s-1" });',
            '        process.exit(0);',
            '    }',
            '});',
        ].join('\n');
        const realSpawn: SpawnFunction = (_command, args, options) => spawnProcess(process.execPath, ['-e', fakeCli, '--', ...args], options);
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: realSpawn, environment: { PATH: process.env.PATH ?? '', FAKE_TOOL_PID_FILE: pidFile } });
        const seen: AgentEvent[] = [];

        // The stop comes once the tool call is on screen and the command runs.
        // The events are an async iterator, so `for await` is the only loop form that fits.
        for await (const event of engine.runTurn(makeRequest({ abortSignal: controller.signal }))) {
            seen.push(event);
            if (event.type === 'tool_started') {
                await vi.waitFor(() => {
                    expect(existsSync(pidFile))
                        .toBe(true);
                });
                controller.abort();
            }
        }

        const toolPid = Number(readFileSync(pidFile, 'utf8'));

        await vi.waitFor(() => {
            expect(isProcessAlive(toolPid))
                .toBe(false);
        });
        expect(seen.filter(event => event.type === 'turn_error'))
            .toEqual([]);
        expect(released())
            .toBe(1);
    }, 15000);

    it('kills the process group after a clean exit on POSIX, and sends nothing on Windows once the CLI exited', async () => {
        const { loopback } = makeLoopback();
        const signals: string[] = [];
        const { spawn } = scriptedSpawn({ stdout: fixture('text'), exitCode: 0 });
        const engine = new ClaudeCliEngine({
            loopback,
            spawnFunction: spawn,
            environment: {},
            signalProcess: (_child, action) => {
                signals.push(action);
            },
        });

        await collect(engine.runTurn(makeRequest()));

        expect(signals)
            .toEqual(process.platform === 'win32' ? [] : ['KILL']);
    });

    it.each([
        ['win32', ['KILL']],
        ['linux', ['TERM', 'KILL']],
    ])('on %s, a stop the CLI ignores sends %j first', async (platform, expected) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const original = Object.getOwnPropertyDescriptor(process, 'platform');

        Object.defineProperty(process, 'platform', { value: platform });
        try {
            const { loopback } = makeLoopback();
            const controller = new AbortController();
            const signals: string[] = [];
            const { spawn, children } = scriptedSpawn({ stdout: '', exitCode: null, hangs: true });
            const engine = new ClaudeCliEngine({
                loopback,
                spawnFunction: spawn,
                environment: {},
                signalProcess: (_child, action) => {
                    signals.push(action);
                    // Only KILL ends the fake CLI, so the TERM step waits out its grace period.
                    if (action === 'KILL') {
                        children[0]?.stdout.end();
                        children[0]?.emit('exit', null);
                    }
                },
            });

            const eventsPromise = collect(engine.runTurn(makeRequest({ abortSignal: controller.signal })));

            // The memory file is read before the spawn, and that read is real I/O, so wait for the fake child to exist.
            await vi.waitFor(() => {
                expect(children)
                    .toHaveLength(1);
            });
            controller.abort();
            await vi.advanceTimersByTimeAsync(60_000);
            await eventsPromise;

            expect(signals.slice(0, expected.length))
                .toEqual(expected);
        } finally {
            if (original) {
                Object.defineProperty(process, 'platform', original);
            }
            vi.useRealTimers();
        }
    });

    it.each([
        ['win32', []],
        ['linux', ['KILL']],
    ])('on %s, a clean exit sends %j', async (platform, expected) => {
        const original = Object.getOwnPropertyDescriptor(process, 'platform');

        Object.defineProperty(process, 'platform', { value: platform });
        try {
            const { loopback } = makeLoopback();
            const signals: string[] = [];
            const { spawn } = scriptedSpawn({ stdout: fixture('text'), exitCode: 0 });
            const engine = new ClaudeCliEngine({
                loopback,
                spawnFunction: spawn,
                environment: {},
                signalProcess: (_child, action) => {
                    signals.push(action);
                },
            });

            await collect(engine.runTurn(makeRequest()));

            expect(signals)
                .toEqual(expected);
        } finally {
            if (original) {
                Object.defineProperty(process, 'platform', original);
            }
        }
    });

    it('appends the workspace CLAUDE.md to the system prompt file, after the bot profile', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'cloudbot-memory-'));
        const written = new Map<string, string>();
        const loopback: LoopbackToolServer = {
            grantTurn: (): LoopbackTurn => ({
                folder: workspace,
                mcpConfigPath: '/t/mcp.json',
                settingsPath: '/t/settings.json',
                noteToolUse: () => undefined,
                writeFile(name: string, text: string): string {
                    written.set(name, text);

                    return `/t/${name}`;
                },
                allowCall: () => undefined,
                mcpUrl: 'http://127.0.0.1:1/mcp',
                token: 'fake-token',
                release: () => undefined,
            }),
            close: () => Promise.resolve(),
        };

        writeFileSync(join(workspace, 'CLAUDE.md'), 'Owner likes short answers.');

        const { spawn } = scriptedSpawn({ stdout: fixture('text'), exitCode: 0 });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        await collect(engine.runTurn(makeRequest({ workspaceDir: workspace, systemPrompt: 'You are Ana.' })));

        const prompt = written.get('system-prompt.txt') ?? '';

        expect(prompt)
            .toContain('You are Ana.');
        expect(prompt)
            .toContain('Owner likes short answers.');
        expect(prompt.indexOf('You are Ana.'))
            .toBeLessThan(prompt.indexOf('Owner likes short answers.'));
    });

    it('keeps stdin open for the interrupt and ends it once the result arrives', async () => {
        const { loopback } = makeLoopback();
        const { spawn, children } = scriptedSpawn({ stdout: fixture('text'), exitCode: 0 });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        await collect(engine.runTurn(makeRequest()));

        expect(children[0]?.stdin.writableEnded)
            .toBe(true);
    });

    it('records each tool_use the CLI prints on the turn, so the decision routes can match it', async () => {
        const { loopback, notes } = makeLoopback();
        const { spawn } = scriptedSpawn({ stdout: fixture('tool'), exitCode: 0 });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        await collect(engine.runTurn(makeRequest()));

        expect(notes)
            .toEqual(['toolu_rec1:mcp__cloudbot__echo']);
    });
    it('does not start the CLI when the turn was already aborted', async () => {
        const { loopback } = makeLoopback();
        const controller = new AbortController();
        const { spawn } = scriptedSpawn({ stdout: fixture('text'), exitCode: 0 });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        controller.abort();
        const events = await collect(engine.runTurn(makeRequest({ abortSignal: controller.signal })));

        expect(events)
            .toEqual([]);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('refuses every tool call when the turn has no review, and sends the tools to the loopback grant', async () => {
        const { loopback, grants } = makeLoopback();
        const { spawn } = scriptedSpawn({ stdout: fixture('text'), exitCode: 0 });
        const engine = new ClaudeCliEngine({ loopback, spawnFunction: spawn, environment: {} });

        await collect(engine.runTurn(makeRequest()));

        const grant = grants[0];

        expect(grant?.tools)
            .toEqual([]);
        await expect(grant?.reviewToolCall({ toolName: 'mcp__cloudbot__echo', input: {} }, new AbortController().signal)).resolves.toMatchObject({ isAllowed: false });
    });
});
