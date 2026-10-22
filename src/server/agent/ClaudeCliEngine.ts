import { execFile, spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import type { AgentEvent, TurnErrorEvent } from './AgentEvent.ts';
import type { AgentRunner, ToolCallDecision, TurnRequest } from './AgentRunner.ts';
import { validateAgentIsolation } from './buildClaudeCommand.ts';
import { buildCliDisallowedTools } from './buildCliDisallowedTools.ts';
import { buildAgentEnvironment, validateAgentUser } from './createAgentUserSpawn.ts';
import { APPROVE_TOOL_NAME, BUILTIN_TOOLS } from './createLoopbackToolServer.ts';
import type { LoopbackToolServer, LoopbackTurn, LoopbackTurnGrant } from './createLoopbackToolServer.ts';
import { PROFILE_SERVER_NAME } from './createProfileToolServer.ts';
import { prepareAgentWorkspace } from './prepareAgentWorkspace.ts';
import { readWorkspaceMemoryBlock } from './readWorkspaceMemory.ts';
import { TURN_MARKER_VARIABLE, createTurnMarker, endTurnLeftovers } from './endTurnLeftovers.ts';
import { mapCliMessage, rememberResetsAt, withResetsAt } from './mapCliMessage.ts';
import type { CliMessage } from './mapCliMessage.ts';
import { isClaudeModel } from '../models/modelChoices.ts';

type SpawnFunction = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type SignalAction = 'TERM' | 'KILL';

interface ClaudeCliEngineOptions {
    loopback: LoopbackToolServer;
    agentUser?: string | undefined;
    pathToClaudeCodeExecutable?: string | undefined;
    environment?: Record<string, string> | undefined;
    // Tests inject a fake here. Production leaves it out and spawns the CLI.
    spawnFunction?: SpawnFunction | undefined;
    // Tests inject a fake here too. Production sends TERM, then KILL, to the process tree.
    signalProcess?: ((child: ChildProcess, action: SignalAction) => void) | undefined;
    // Tests inject a fake here too. Production ends the processes that still carry the turn's marker.
    endLeftovers?: ((marker: string, agentUser: string | undefined) => void) | undefined;
}

interface CliTurnFiles {
    mcpConfigPath: string;
    settingsPath: string;
    systemPromptPath?: string | undefined;
    agentsPath?: string | undefined;
}

interface CliExit {
    code: number | null;
    spawnError: Error | undefined;
}

const STDERR_TAIL_LENGTH = 4096;
// After the CLI exits, its output is read for this long, then the pipes are closed. A grandchild may hold them open.
const EXIT_GRACE_MS = 2000;
// A stop asks the CLI to end the turn first, and waits this long for its result and exit.
const INTERRUPT_GRACE_MS = 5000;
// Then the CLI gets TERM for this long before the tree is killed.
const TERM_GRACE_MS = 5000;
// After KILL, the exit is awaited this long at most, so a stop never hangs.
const KILL_WAIT_MS = 5000;
const NO_PROXY_VALUE = '127.0.0.1,localhost';
const APPROVE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${APPROVE_TOOL_NAME}`;

// The CLI reads one user message from stdin. Images go in as base64 blocks of the same message.
function buildUserMessage(request: TurnRequest): string {
    const images = request.images ?? [];
    const imageBlocks = images.map(image => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
    }));
    const content = images.length === 0 ? request.prompt : [{ type: 'text', text: request.prompt }, ...imageBlocks];
    const message = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };

    return `${JSON.stringify(message)}\n`;
}

// The control request the engine sends for a stop. The CLI ends the turn and keeps the session.
function buildInterruptMessage(requestId: string): string {
    const message = { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };

    return `${JSON.stringify(message)}\n`;
}

// Every built-in tool is listed in --tools and as an ask rule, so no other built-in exists for the model.
// The prompt tool is hidden from the model with --disallowedTools; the CLI still calls it as the permission tool.
// --setting-sources '' keeps the user, project and local settings out, so nothing bot-writable can add rules.
// The variadic --disallowedTools and --add-dir come last, so the next flag ends their values.
function buildCliArguments(request: TurnRequest, files: CliTurnFiles): string[] {
    const resumeArgs = request.sessionId ? ['--resume', request.sessionId] : [];
    const modelArgs = request.model === undefined || !isClaudeModel(request.model) ? [] : ['--model', request.model];
    const effortArgs = request.effort === undefined ? [] : ['--effort', request.effort];
    const systemPromptArgs = files.systemPromptPath === undefined ? [] : ['--append-system-prompt-file', files.systemPromptPath];
    const agentArgs = files.agentsPath === undefined ? [] : ['--agents', files.agentsPath];
    const maxStepsArgs = request.maxSteps === undefined ? [] : ['--max-turns', String(request.maxSteps)];
    const maxSpendArgs = request.maxSpendUsd === undefined ? [] : ['--max-budget-usd', String(request.maxSpendUsd)];
    const disallowed = [APPROVE_TOOL_FULL_NAME, ...buildCliDisallowedTools(request.disallowedTools ?? [])];
    const directories = request.additionalDirectories ?? [];
    const directoryArgs = directories.length === 0 ? [] : ['--add-dir', ...directories];

    return [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--mcp-config', files.mcpConfigPath,
        '--strict-mcp-config',
        '--setting-sources', '',
        '--settings', files.settingsPath,
        '--permission-prompt-tool', APPROVE_TOOL_FULL_NAME,
        '--tools', BUILTIN_TOOLS.join(','),
        ...resumeArgs,
        ...modelArgs,
        ...effortArgs,
        ...systemPromptArgs,
        ...agentArgs,
        ...maxStepsArgs,
        ...maxSpendArgs,
        '--disallowedTools', ...disallowed,
        ...directoryArgs,
    ];
}

function parseCliLine(line: string): CliMessage | undefined {
    if (line.trim() === '') {
        return undefined;
    }

    try {
        // Each line is one stream-json message, typed as CliMessage.
        return JSON.parse(line) as CliMessage;
    } catch {
        return undefined;
    }
}

// Every tool_use the CLI prints is one the decision route may answer. The noting happens on the line event, as the line arrives.
function noteToolUses(line: string, turn: LoopbackTurn): void {
    const message = parseCliLine(line);

    if (message === undefined || message.type !== 'assistant') {
        return;
    }

    message.message.content.forEach((block) => {
        if (block.type === 'tool_use') {
            turn.noteToolUse(block.id, block.name, block.input);
        }
    });
}

// NO_PROXY and no_proxy get the loopback addresses, after any value the server already has.
function noProxyValues(inherited: Record<string, string | undefined>): Record<string, string> {
    const existing = [inherited.NO_PROXY, inherited.no_proxy].filter((value): value is string => value !== undefined && value !== '');
    const value = [...existing, NO_PROXY_VALUE].join(',');

    return { NO_PROXY: value, no_proxy: value };
}

// The environment of a CLI turn. The agent user gets only the variables sudo keeps, so the bot's own environment is never passed.
function buildEnvironment(options: ClaudeCliEngineOptions, extraEnvironment: Record<string, string>): Record<string, string> {
    if (options.agentUser) {
        return buildAgentEnvironment(options.agentUser, options.environment, extraEnvironment);
    }

    if (options.environment) {
        return { ...options.environment, ...extraEnvironment };
    }

    const definedEntries = Object.entries(process.env)
        .filter((entry): entry is [string, string] => entry[1] !== undefined);
    const inherited = Object.fromEntries(definedEntries);

    return { ...inherited, ...extraEnvironment };
}

// The owner's remote servers go into the CLI config. The bot's own tools are served by the loopback endpoint.
function externalServers(request: TurnRequest): Record<string, unknown> | undefined {
    const servers = request.mcpServers ?? {};

    return Object.keys(servers).length === 0 ? undefined : servers;
}

function refuseUnreviewed(): Promise<ToolCallDecision> {
    return Promise.resolve({ isAllowed: false, reason: 'Tool calls are not reviewed for this turn, so the action was not run.' });
}

function buildGrant(request: TurnRequest): LoopbackTurnGrant {
    const reviewToolCall = request.reviewToolCall ?? refuseUnreviewed;
    const remoteServers = externalServers(request);

    return { tools: request.tools ?? [], reviewToolCall, remoteServers, disallowedTools: request.disallowedTools };
}

// Reads the flag at call time. A check after an await is not narrowed to the value read before it.
function isAborted(signal: AbortSignal): boolean {
    return signal.aborted;
}

// Resolves true when the process exits within the time, false otherwise.
function exitsWithin(exited: Promise<CliExit>, milliseconds: number): Promise<boolean> {
    const timeout = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            resolve(false);
        }, milliseconds);

        timer.unref();
    });

    return Promise.race([exited.then(() => true), timeout]);
}

// The root-owned wrapper that signals one group of the agent user. It takes a positive group id and TERM or KILL, nothing else.
const SIGNAL_GROUP_PATH = '/usr/local/bin/cloudbot-signal-group';

// TERM and KILL for the CLI's process tree. Windows: taskkill /T ends the tree, and TERM ends only the CLI.
// POSIX: the CLI leads its own process group, so the signal goes to the group, descendants included, even after the leader exited.
// Agent user: the direct kill of the group is expected to fail with EPERM, since the group belongs to the agent user. The direct
// call still reaches the cloudbot-owned sudo leader. The sudo wrapper does the group work for TERM and KILL, see the sudoers file.
// The group id is the sudo pid, which is unverified on this PC.
function signalProcessTree(child: ChildProcess, action: SignalAction, agentUser: string | undefined): void {
    const pid = child.pid;

    if (pid === undefined) {
        return;
    }

    if (process.platform === 'win32') {
        if (action === 'TERM') {
            child.kill('SIGTERM');

            return;
        }

        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => undefined);

        return;
    }

    const signal = action === 'TERM' ? 'SIGTERM' : 'SIGKILL';

    try {
        process.kill(-pid, signal);
    } catch {
        // The group is already gone. No fallback to the bare pid: after the leader exits, that pid may belong to another process.
    }

    if (agentUser !== undefined) {
        execFile('/usr/bin/sudo', ['-n', '-u', agentUser, '--', SIGNAL_GROUP_PATH, String(pid), action], () => undefined);
    }
}

class ClaudeCliEngine implements AgentRunner {
    private readonly options: ClaudeCliEngineOptions;
    private readonly spawnFunction: SpawnFunction;
    // Stops for the CLI processes that are running now. close() calls them when the server shuts down.
    private readonly stops = new Set<() => Promise<void>>();

    constructor(options: ClaudeCliEngineOptions) {
        const agentUser = options.agentUser ?? process.env.CLOUDBOT_AGENT_USER;
        const pathToClaudeCodeExecutable = options.pathToClaudeCodeExecutable ?? process.env.CLAUDE_PATH;

        validateAgentIsolation(agentUser);
        if (agentUser) {
            validateAgentUser(agentUser);
            if (!(pathToClaudeCodeExecutable ?? '').startsWith('/')) {
                throw new Error('The agent CLI path must be absolute.');
            }
        }

        // A .cmd shim is a batch file, so a stop would signal cmd.exe and not the CLI.
        if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(pathToClaudeCodeExecutable ?? '')) {
            throw new Error('Point the CLI path at claude.exe, not at the .cmd or .bat shim.');
        }

        this.options = { ...options, agentUser, pathToClaudeCodeExecutable };
        this.spawnFunction = options.spawnFunction ?? spawn;
    }

    async* runTurn(request: TurnRequest): AsyncGenerator<AgentEvent> {
        // An abort event that already fired is never seen again, so check the state first.
        if (request.abortSignal.aborted) {
            return;
        }

        if (this.options.agentUser) {
            try {
                await prepareAgentWorkspace(request.workspaceDir);
            } catch (error: unknown) {
                console.error('Could not prepare the agent workspace:', error);
                yield { type: 'turn_error', message: 'Could not prepare the agent workspace. Please try again.', isUsageLimit: false };

                return;
            }
        }

        // The abort may have come during the preparation, which has no listener yet.
        if (isAborted(request.abortSignal)) {
            return;
        }

        const grant = buildGrant(request);
        const turn = this.options.loopback.grantTurn(grant);

        try {
            yield* this.runProcess(request, turn);
        } finally {
            turn.release();
        }
    }

    // Stops the CLI processes that run now, for the server shutdown. Each stop is bounded, so this never hangs.
    async close(): Promise<void> {
        const stops = [...this.stops];

        const pending = stops.map(stop => stop());

        await Promise.all(pending);
    }

    private async* runProcess(request: TurnRequest, turn: LoopbackTurn): AsyncGenerator<AgentEvent> {
        // The workspace CLAUDE.md is the bot's memory. --setting-sources '' keeps the CLI from loading it, so the server reads it here.
        const memoryBlock = await readWorkspaceMemoryBlock(request.workspaceDir);
        const systemPromptText = [request.systemPrompt, memoryBlock]
            .filter((part): part is string => part !== undefined && part !== '')
            .join('\n\n');
        const systemPromptPath = systemPromptText === '' ? undefined : turn.writeFile('system-prompt.txt', systemPromptText);
        const agentsText = request.agents === undefined ? undefined : JSON.stringify(request.agents);
        const agentsPath = agentsText === undefined ? undefined : turn.writeFile('agents.json', agentsText);
        const args = buildCliArguments(request, { mcpConfigPath: turn.mcpConfigPath, settingsPath: turn.settingsPath, systemPromptPath, agentsPath });
        const inherited = this.options.environment ?? process.env;
        // The marker comes last, so no variable of the request can replace it.
        const turnMarker = createTurnMarker();
        const extraEnvironment = { ...noProxyValues(inherited), ...request.extraEnvironment, [TURN_MARKER_VARIABLE]: turnMarker };
        const environment = buildEnvironment(this.options, extraEnvironment);
        const command = this.commandFor(args);
        const child = this.spawnFunction(command.file, command.args, {
            cwd: request.workspaceDir,
            env: environment,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
            // On POSIX the CLI leads its own process group, so a stop can signal its tools too.
            detached: process.platform !== 'win32',
        });
        const stdout = child.stdout;

        if (stdout === null) {
            throw new Error('The Claude CLI was started without an output pipe.');
        }

        let stderrTail = '';

        child.stderr?.on('data', (chunk: Buffer) => {
            stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LENGTH);
        });
        // A second error on the child is never uncaught, and a stdin write after an early exit is not an error either.
        child.on('error', () => undefined);
        child.stdin?.on('error', () => undefined);

        let exitResult: CliExit | undefined;
        const exited = new Promise<CliExit>((resolve) => {
            child.once('exit', (code: number | null) => {
                exitResult = { code, spawnError: undefined };
                resolve(exitResult);
            });
            child.once('error', (error: Error) => {
                exitResult = { code: null, spawnError: error };
                resolve(exitResult);
            });
        });

        const lines = createInterface({ input: stdout, crlfDelay: Infinity });
        const closeStreams = (): void => {
            stdout.destroy();
            child.stderr?.destroy();
            lines.close();
        };

        // A spawn failure never ends stdout, and a child that exited leaves its pipes open only if a grandchild holds them.
        void exited.then((result) => {
            if (result.spawnError !== undefined) {
                lines.close();

                return;
            }

            setTimeout(closeStreams, EXIT_GRACE_MS)
                .unref();
        });

        // Stdin stays open while the turn runs, so a stop can send the interrupt. It closes after the result, and the CLI exits then.
        let inputEnded = false;
        const endInput = (): void => {
            if (!inputEnded) {
                inputEnded = true;
                child.stdin?.end();
            }
        };

        const signalChild = this.options.signalProcess ?? ((target: ChildProcess, action: SignalAction) => {
            signalProcessTree(target, action, this.options.agentUser);
        });
        let stopping: Promise<void> | undefined;
        const runStop = async (): Promise<void> => {
            if (exitResult === undefined) {
                const requestId = `stop-${randomUUID()}`;
                const interrupt = buildInterruptMessage(requestId);

                child.stdin?.write(interrupt);

                if (!(await exitsWithin(exited, INTERRUPT_GRACE_MS))) {
                    // Windows skips TERM: it would end the CLI alone, and taskkill /T could then no longer reach its tools.
                    let exitedAfterTerm = false;

                    if (process.platform !== 'win32') {
                        signalChild(child, 'TERM');
                        exitedAfterTerm = await exitsWithin(exited, TERM_GRACE_MS);
                    }

                    if (!exitedAfterTerm) {
                        signalChild(child, 'KILL');
                        await exitsWithin(exited, KILL_WAIT_MS);
                    }
                }
            }

            // The group can outlive its leader, so POSIX cleans it up even after a clean exit. On Windows an exited pid may be
            // reused, so nothing is sent once the CLI has exited.
            if (exitResult === undefined || process.platform !== 'win32') {
                signalChild(child, 'KILL');
            }
            endInput();
            closeStreams();
        };
        const stopChild = (): Promise<void> => {
            if (stopping === undefined) {
                stopping = runStop();
            }

            return stopping;
        };

        const stop = { isStopped: false };
        const onAbort = (): void => {
            stop.isStopped = true;
            void stopChild();
        };

        this.stops.add(stopChild);
        request.abortSignal.addEventListener('abort', onAbort, { once: true });
        // An abort that came before the listener existed is caught here, so no CLI runs past it.
        if (request.abortSignal.aborted) {
            onAbort();
        }

        const userMessage = buildUserMessage(request);

        child.stdin?.write(userMessage);

        let latestResetsAt: number | undefined;
        let sawResult = false;

        lines.on('line', (line: string) => {
            noteToolUses(line, turn);
        });

        try {
            // The line reader is an async iterator, so `for await` is the only loop form that fits. Plain loops are banned by lint.
            for await (const line of lines) {
                const message = parseCliLine(line);

                // The result ends the input even during a stop, so the CLI exits at once and does not wait for the grace period.
                if (message?.type === 'result') {
                    sawResult = true;
                    endInput();
                }

                // While stopping, the lines are still read, so the result arrives and closes stdin. Their events are dropped.
                if (stop.isStopped || message === undefined) {
                    continue;
                }

                const mappedEvents = mapCliMessage(message);
                // A message that maps to no event still shows the turn is alive, such as tool progress or a retry.
                const agentEvents: AgentEvent[] = mappedEvents.length === 0 ? [{ type: 'activity' }] : mappedEvents;

                agentEvents.forEach((agentEvent) => {
                    latestResetsAt = rememberResetsAt(agentEvent, latestResetsAt);
                });

                const turnEvents = agentEvents.map(agentEvent => withResetsAt(agentEvent, latestResetsAt));

                yield* turnEvents;
            }
        } finally {
            lines.close();
            request.abortSignal.removeEventListener('abort', onAbort);
            // Every path ends here, so the group is killed even after a clean exit: an approved command may still run in it.
            await stopChild();
            this.stops.delete(stopChild);
            // A command that started its own session is outside the group, so it is found by the turn's marker (#165).
            (this.options.endLeftovers ?? endTurnLeftovers)(turnMarker, this.options.agentUser);
        }

        const result = await exited;

        // The owner stopped the turn, so the exit is not an error.
        if (stop.isStopped) {
            return;
        }

        const failure = this.failureEvent(result, sawResult, stderrTail);

        if (failure !== undefined) {
            yield withResetsAt(failure, latestResetsAt);
        }
    }

    // A turn ends with a result message. An exit without one is an error, whatever the exit code.
    private failureEvent(exitResult: CliExit, sawResult: boolean, stderrText: string): TurnErrorEvent | undefined {
        if (exitResult.spawnError !== undefined) {
            console.error('Could not start the Claude CLI:', exitResult.spawnError.message);

            return { type: 'turn_error', message: 'Could not start the Claude CLI. Check the server setup.', isUsageLimit: false };
        }

        // A result message already reported the outcome of the turn, including its failures.
        if (sawResult) {
            return undefined;
        }

        if (stderrText) {
            // Keep untrusted CLI text on one quoted line in error reports.
            const report = JSON.stringify({ stderrTail: stderrText, exitCode: exitResult.code });

            console.error('Agent process diagnostics:', report);
        }

        return { type: 'turn_error', message: 'The Claude CLI stopped before the turn ended.', isUsageLimit: false };
    }

    // The sudoers line allows only the native CLI path for the agent user, so the executable is never a shell command.
    private commandFor(args: string[]): { file: string; args: string[] } {
        const executable = this.options.pathToClaudeCodeExecutable ?? 'claude';

        if (this.options.agentUser) {
            return { file: '/usr/bin/sudo', args: ['-n', '-u', this.options.agentUser, '--', executable, ...args] };
        }

        return { file: executable, args };
    }
}

export { ClaudeCliEngine, buildCliArguments, buildInterruptMessage, buildUserMessage, noProxyValues, signalProcessTree };
export type { ClaudeCliEngineOptions, CliTurnFiles, SignalAction, SpawnFunction };
