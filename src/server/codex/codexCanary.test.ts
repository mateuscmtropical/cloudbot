import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ToolCall, ToolCallDecision } from '../agent/AgentRunner.ts';
import { CodexApprovalBridge } from './CodexApprovalBridge.ts';
import type { CodexMessage } from './CodexApprovalBridge.ts';
import { CODEX_VERSION, buildCodexThreadStart } from './codexThreadConfig.ts';

// The canary runs the real codex app-server against a fake model server on 127.0.0.1 and a fake MCP server, so no
// request leaves the machine. It runs only when CODEX_PATH names a Codex binary, as in the "Codex canary" CI job.
// Run it on every Codex upgrade: it fails when a tool can run without reaching CloudBot's review.
const CODEX_PATH = process.env.CODEX_PATH;

// The commands from the provider spike on issue #128. Each one writes a marker, so a command that ran leaves a file.
const COMMANDS = [
    'ls > ran-ls.txt',
    'cat /etc/hostname > ran-cat.txt',
    'git status > ran-git.txt',
    'grep -r x . > ran-grep.txt',
    'echo aGk= | base64 -d > ran-base64.txt',
    'cat ~/.ssh/id_rsa > ran-ssh.txt',
];
const MARKER_FILES = ['ran-ls.txt', 'ran-cat.txt', 'ran-git.txt', 'ran-grep.txt', 'ran-base64.txt', 'ran-ssh.txt'];
const PATCH = '*** Begin Patch\n*** Add File: ran-patch.txt\n+hello\n*** End Patch';

interface ModelStep {
    name: string;
    namespace?: string;
    args: unknown;
}

const STEPS: ModelStep[] = [
    ...COMMANDS.map(cmd => ({ name: 'exec_command', args: { cmd } })),
    { name: 'exec_command', args: { cmd: `apply_patch <<'PATCH'\n${PATCH}\nPATCH` } },
    { name: 'peek', namespace: 'mcp__cloud', args: { note: 'secret' } },
    { name: 'read_mcp_resource', args: { server: 'cloud', uri: 'file:///etc/hostname' } },
];
// Every tool the model may be offered. A new Codex that offers anything else fails the canary until it is checked.
const OFFERED_TOOLS = ['exec_command', 'write_stdin', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'request_user_input', 'mcp__cloud'];

// A stdio MCP server with one tool that claims to be read only. It writes each request it gets to a log file.
const FAKE_MCP_SOURCE = `
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const log = process.argv[2];
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    appendFileSync(log, String(message.method) + '\\n');
    if (message.id === undefined) return;
    if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'cloud', version: '1' } } });
    if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'peek', description: 'Reads a note.', inputSchema: { type: 'object', properties: { note: { type: 'string' } } }, annotations: { readOnlyHint: true } }] } });
    if (message.method === 'tools/call') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'peeked' }] } });
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not here.' } });
});
`;

interface ModelRequest {
    tools: { name?: string; type?: string }[];
}

function sseEvent(event: Record<string, unknown>): string {
    return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

// Answers each model request with the next tool call of the plan, then with a final text. Keeps every request body.
function startFakeModel(requests: ModelRequest[]): Promise<{ port: number; close: () => void }> {
    let stepIndex = 0;
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];

        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            const bodyText = Buffer.concat(chunks)
                .toString('utf8');

            if (!request.url?.endsWith('/responses')) {
                response.writeHead(404);
                response.end();

                return;
            }

            requests.push(JSON.parse(bodyText) as ModelRequest);
            const step = STEPS[stepIndex];
            const responseId = `resp_${String(stepIndex)}`;
            const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
            const item = step === undefined
                ? { type: 'message', id: `msg_${String(stepIndex)}`, role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }] }
                : { type: 'function_call', id: `fc_${String(stepIndex)}`, call_id: `call_${String(stepIndex)}`, name: step.name, arguments: JSON.stringify(step.args), ...(step.namespace === undefined ? {} : { namespace: step.namespace }) };
            const events = [
                { type: 'response.created', response: { id: responseId } },
                { type: 'response.output_item.added', output_index: 0, item },
                { type: 'response.output_item.done', output_index: 0, item },
                { type: 'response.completed', response: { id: responseId, usage } },
            ];

            stepIndex += 1;
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(events.map(sseEvent)
                .join(''));
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address() as AddressInfo;

            resolve({ port: address.port, close: () => server.close() });
        });
    });
}

describe.runIf(CODEX_PATH !== undefined)(`codex ${CODEX_VERSION} canary`, () => {
    const reviewed: ToolCall[] = [];
    const modelRequests: ModelRequest[] = [];
    let folder = '';
    let workDir = '';
    let mcpLog = '';
    let turnStatus: unknown;

    beforeAll(async () => {
        folder = mkdtempSync(join(tmpdir(), 'cloudbot-codex-canary-'));
        workDir = join(folder, 'work');
        mcpLog = join(folder, 'mcp.log');
        const codexHome = join(folder, 'codex-home');
        const mcpPath = join(folder, 'fake-mcp.cjs');

        mkdirSync(workDir);
        mkdirSync(codexHome);
        writeFileSync(mcpPath, FAKE_MCP_SOURCE);
        writeFileSync(mcpLog, '');

        const model = await startFakeModel(modelRequests);
        const providerConfig = `model_providers.fake={name="fake",base_url="http://127.0.0.1:${String(model.port)}/v1",wire_api="responses",env_key="FAKE_MODEL_KEY"}`;
        const child = spawn(CODEX_PATH ?? 'codex', ['app-server', '-c', providerConfig, '-c', 'model_provider="fake"', '-c', 'model="fake-model"'], {
            cwd: workDir,
            // An obviously fake key for the fake server. HOME is the scratch folder, so no real config is read.
            env: { PATH: process.env.PATH ?? '', HOME: folder, CODEX_HOME: codexHome, FAKE_MODEL_KEY: 'fake-key-not-real', NO_PROXY: '127.0.0.1' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const pending = new Map<number, (message: Record<string, unknown>) => void>();
        let nextId = 1;
        // The bridge exists once thread/start has answered with the thread id.
        const session: { bridge?: CodexApprovalBridge } = {};
        const turnDone = new Promise<void>((resolve) => {
            const write = (message: unknown): void => {
                child.stdin.write(`${JSON.stringify(message)}\n`);
            };

            const lines = createInterface({ input: child.stdout });

            lines.on('line', (line) => {
                const message = JSON.parse(line) as CodexMessage & Record<string, unknown>;
                const isResponse = typeof message.id === 'number' && message.method === undefined;

                if (isResponse) {
                    pending.get(message.id as number)?.(message);

                    return;
                }

                if (message.id !== undefined) {
                    const answerPromise = session.bridge === undefined
                        ? Promise.resolve({ error: { code: -32601, message: 'No thread yet.' } })
                        : session.bridge.answerRequest(message, new AbortController().signal);

                    void answerPromise.then((answer) => {
                        write({ jsonrpc: '2.0', id: message.id, ...answer });
                    });

                    return;
                }

                session.bridge?.noteNotification(message);

                if (message.method === 'turn/completed') {
                    const params = message.params as { turn: { status: unknown } };

                    turnStatus = params.turn.status;
                    resolve();
                }
            });
        });
        const send = (method: string, params: unknown): Promise<Record<string, unknown>> => new Promise((resolve) => {
            const id = nextId;

            nextId += 1;
            pending.set(id, resolve);
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
        const review = (call: ToolCall): Promise<ToolCallDecision> => {
            reviewed.push(call);

            return Promise.resolve({ isAllowed: false, reason: 'The canary refuses every call.' });
        };

        await send('initialize', { clientInfo: { name: 'cloudbot-canary', version: '0' }, capabilities: { experimentalApi: false, requestAttestation: false } });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
        const threadParams = buildCodexThreadStart(workDir, { cloud: { command: process.execPath, args: [mcpPath, mcpLog] } });
        const thread = await send('thread/start', threadParams);
        const threadId = (thread.result as { thread: { id: string } }).thread.id;

        session.bridge = new CodexApprovalBridge({ threadId, reviewToolCall: review });
        await send('turn/start', { threadId, input: [{ type: 'text', text: 'go', text_elements: [] }] });
        await turnDone;
        child.kill();
        model.close();
    }, 90_000);

    afterAll(() => {
        rmSync(folder, { recursive: true, force: true });
    });

    it('finishes the turn', () => {
        expect(turnStatus)
            .toBe('completed');
    });

    it('offers the model only the known tools, and none of view_image, spawn_agent or web_search', () => {
        const firstTools = modelRequests[0]?.tools ?? [];
        const toolNames = firstTools.map(tool => tool.name ?? tool.type);

        expect(toolNames.toSorted())
            .toEqual(OFFERED_TOOLS.toSorted());
    });

    it('sends every command to the review, and a refused command never runs', () => {
        const reviewedCommands = reviewed.filter(call => call.toolName === 'Bash')
            .map(call => String((call.input as { command?: unknown }).command));
        const ranFiles = MARKER_FILES.filter(name => existsSync(join(workDir, name)));

        expect(reviewedCommands)
            .toHaveLength(COMMANDS.length);
        COMMANDS.forEach((command, index) => {
            expect(reviewedCommands[index])
                .toContain(command);
        });
        expect(ranFiles)
            .toEqual([]);
    });

    it('sends the patch to the review with its file, and a refused patch writes nothing', () => {
        const edit = reviewed.find(call => call.toolName === 'Edit');

        expect(JSON.stringify(edit?.input))
            .toContain('ran-patch.txt');
        expect(existsSync(join(workDir, 'ran-patch.txt')))
            .toBe(false);
    });

    it('sends the MCP call to the review, also for a read-only tool, and a refused call never reaches the server', () => {
        const mcpCall = reviewed.find(call => call.toolName === 'mcp__cloud__peek');
        const serverMethods = readFileSync(mcpLog, 'utf8')
            .split('\n');

        expect(mcpCall?.input)
            .toEqual({ note: 'secret' });
        expect(serverMethods)
            .not.toContain('tools/call');
    });

    // Known gap from the provider spike: the MCP resource tools ask nothing. it.fails keeps it visible. Once Codex gates
    // them, this test starts to fail, and it should become a normal test.
    it.fails('keeps read_mcp_resource from reaching the server without a review', () => {
        const serverMethods = readFileSync(mcpLog, 'utf8')
            .split('\n');

        expect(serverMethods)
            .not.toContain('resources/read');
    });
});
