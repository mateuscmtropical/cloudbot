import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { AppProxy } from '../apps/AppProxy.ts';
import type { AgentEvent } from './AgentEvent.ts';
import type { ToolCall } from './AgentRunner.ts';
import { CodexEngine } from './CodexEngine.ts';
import { CODEX_PROTOCOL_VERSION } from './codexProtocol.ts';
import { startLoopbackToolServer } from './createLoopbackToolServer.ts';
import type { LoopbackToolServer } from './createLoopbackToolServer.ts';
import { PROFILE_SERVER_NAME } from './createProfileToolServer.ts';

// The canary runs the real codex binary against a fake model server on 127.0.0.1, with a fake key and a new CODEX_HOME.
// It never signs in. Run it on every Codex upgrade:
//   CODEX_CANARY_PATH=/absolute/path/to/codex pnpm canary:codex
// It is skipped when the variable is unset, so the normal suite never starts Codex.
const CODEX_PATH = process.env.CODEX_CANARY_PATH ?? '';
const FAKE_KEY = 'fake-local-test-key';
const MARKER_FILE = 'canary-marker.txt';
const PATCHED_FILE = 'patched.txt';
const PATCH = `*** Begin Patch\n*** Add File: ${PATCHED_FILE}\n+hello\n*** End Patch\n`;
// Each command must reach the review before it runs. The last one would leave a file if it ran.
const COMMANDS = ['ls', 'cat /etc/hostname', 'git status', 'grep -r secret .', 'base64 /etc/hostname', 'cat ~/.ssh/id_rsa', `touch ${MARKER_FILE}`];
const TOKEN_PROBE = 'echo token=$CLOUDBOT_TOOLS_TOKEN';
const REMOTE_SERVER_NAME = 'remote';
const REMOTE_RESOURCE_URI = 'file:///canary-secret';
const REMOTE_PROTOCOL_VERSION = '2025-06-18';
const MODEL_CALLS = [
    ...COMMANDS.map(command => ({ name: 'exec_command', arguments: JSON.stringify({ cmd: command }) })),
    { name: 'exec_command', arguments: JSON.stringify({ cmd: `apply_patch <<'EOF'\n${PATCH}EOF\n` }) },
    { name: 'view_image', arguments: JSON.stringify({ path: '/etc/hostname' }) },
    // The bot's own tool: the review refuses the first call and allows the second.
    { name: 'echo', namespace: `mcp__${PROFILE_SERVER_NAME}`, arguments: JSON.stringify({ text: 'refused' }) },
    { name: 'echo', namespace: `mcp__${PROFILE_SERVER_NAME}`, arguments: JSON.stringify({ text: 'allowed' }) },
    // The one command the canary allows. It shows whether the loopback token reaches a command.
    { name: 'exec_command', arguments: JSON.stringify({ cmd: TOKEN_PROBE }) },
    // The permission prompt tool of the Claude engine. It is not listed for Codex, so a call to it must not run.
    { name: 'approve', namespace: `mcp__${PROFILE_SERVER_NAME}`, arguments: JSON.stringify({ tool_name: 'Bash', input: { command: 'ls' } }) },
    // A connected server behind the app proxy: the review refuses the first call and allows the second.
    { name: 'lookup', namespace: `mcp__${REMOTE_SERVER_NAME}`, arguments: JSON.stringify({ query: 'refused' }) },
    { name: 'lookup', namespace: `mcp__${REMOTE_SERVER_NAME}`, arguments: JSON.stringify({ query: 'allowed' }) },
    // The resource tools have no approval in Codex. The proxy must refuse them before they reach the server.
    { name: 'list_mcp_resources', arguments: JSON.stringify({ server: REMOTE_SERVER_NAME }) },
    { name: 'read_mcp_resource', arguments: JSON.stringify({ server: REMOTE_SERVER_NAME, uri: REMOTE_RESOURCE_URI }) },
];
// The only tools Codex may offer the model with the locked config. view_image, web search and helper agents are off.
// With an MCP server Codex adds the resource tools, which have no approval. The loopback server has no resources.
const EXPECTED_TOOLS = ['exec_command', 'list_mcp_resource_templates', 'list_mcp_resources', `mcp__${PROFILE_SERVER_NAME}`, `mcp__${REMOTE_SERVER_NAME}`, 'read_mcp_resource', 'request_user_input', 'write_stdin'];
const EXPECTED_BOT_TOOLS = ['echo'];
const USAGE = { input_tokens: 5, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 10 };

interface ModelRequest {
    tools?: { name?: string; type?: string; tools?: { name: string }[] }[];
    input?: { type?: string; call_id?: string; output?: unknown }[];
}

// A fake Responses API. Each request gets the next scripted call, then a final message.
function startFakeModel(requests: ModelRequest[]): Promise<{ url: string; close: () => void }> {
    const server = createServer((request, response) => {
        let body = '';

        request.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
        });
        request.on('end', () => {
            if (!(request.url ?? '').includes('/responses')) {
                response.writeHead(404);
                response.end('{}');

                return;
            }

            const step = requests.length;
            const responseId = `resp_${String(step)}`;
            const scripted = MODEL_CALLS[step];
            const item = scripted === undefined
                ? { type: 'message', role: 'assistant', id: `msg_${String(step)}`, content: [{ type: 'output_text', text: 'Done.' }] }
                : { type: 'function_call', id: `fc_${String(step)}`, call_id: `call_${String(step)}`, ...scripted };
            const events = [
                { type: 'response.created', response: { id: responseId } },
                { type: 'response.output_item.added', output_index: 0, item },
                { type: 'response.output_item.done', output_index: 0, item },
                { type: 'response.completed', response: { id: responseId, usage: USAGE } },
            ];

            requests.push(JSON.parse(body) as ModelRequest);
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            events.forEach((event) => {
                response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            });
            response.end();
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address() as AddressInfo;

            resolve({ url: `http://127.0.0.1:${String(address.port)}/v1`, close: () => server.close() });
        });
    });
}

interface RemoteMessage {
    id?: number | string;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
}

// A connected MCP server that offers one tool and one resource. It records every request that reaches it.
function startFakeRemoteServer(received: RemoteMessage[]): Promise<{ url: URL; close: () => void }> {
    const answers: Record<string, (message: RemoteMessage) => unknown> = {
        initialize: () => ({ protocolVersion: REMOTE_PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'remote', version: '1.0.0' } }),
        ['tools/list']: () => ({ tools: [{ name: 'lookup', description: 'Looks a word up.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] }),
        ['tools/call']: message => ({ content: [{ type: 'text', text: `found ${String(message.params?.arguments?.query)}` }] }),
        ['resources/list']: () => ({ resources: [{ uri: REMOTE_RESOURCE_URI, name: 'secret' }] }),
        ['resources/read']: () => ({ contents: [{ uri: REMOTE_RESOURCE_URI, text: 'secret' }] }),
        ['resources/templates/list']: () => ({ resourceTemplates: [] }),
    };
    const server = createServer((request, response) => {
        let body = '';

        request.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
        });
        request.on('end', () => {
            if (request.method !== 'POST') {
                response.writeHead(405);
                response.end();

                return;
            }

            const message = JSON.parse(body) as RemoteMessage;
            const answer = message.method === undefined ? undefined : answers[message.method];

            received.push(message);

            if (message.id === undefined) {
                response.writeHead(202);
                response.end();

                return;
            }

            const reply = answer === undefined
                ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method.' } }
                : { jsonrpc: '2.0', id: message.id, result: answer(message) };

            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(reply));
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address() as AddressInfo;

            resolve({ url: new URL(`http://127.0.0.1:${String(address.port)}/mcp`), close: () => server.close() });
        });
    });
}

describe.skipIf(CODEX_PATH === '')(`Codex canary (checked with ${CODEX_PROTOCOL_VERSION})`, () => {
    const requests: ModelRequest[] = [];
    const reviewed: ToolCall[] = [];
    const events: AgentEvent[] = [];
    const folder = mkdtempSync(join(tmpdir(), 'cloudbot-codex-canary-'));
    const workspaceFolder = mkdtempSync(join(folder, 'workspace-'));
    let model: { url: string; close: () => void } | undefined;
    let loopback: LoopbackToolServer | undefined;
    let remote: { url: URL; close: () => void } | undefined;
    const proxy = new AppProxy({ checkUpstream: () => Promise.resolve(['127.0.0.1']) });
    const echoed: string[] = [];
    const remoteReceived: RemoteMessage[] = [];

    beforeAll(async () => {
        model = await startFakeModel(requests);
        loopback = await startLoopbackToolServer(PROFILE_SERVER_NAME);
        remote = await startFakeRemoteServer(remoteReceived);
        await proxy.start();
        const remoteAddress = proxy.register('remote-app', { upstream: remote.url, readToken: () => undefined });
        const engine = new CodexEngine({
            loopback,
            codexPath: CODEX_PATH,
            codexHomeFor: () => join(folder, 'codex-home'),
            environment: { PATH: process.env.PATH ?? '', FAKE_PROVIDER_KEY: FAKE_KEY, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
            extraConfig: [
                'model_provider="fake"',
                'model="fake-model"',
                'model_providers.fake.name="fake"',
                `model_providers.fake.base_url="${model.url}"`,
                'model_providers.fake.wire_api="responses"',
                'model_providers.fake.env_key="FAKE_PROVIDER_KEY"',
            ],
        });

        const turn = engine.runTurn({
            botId: 'canary',
            workspaceDir: workspaceFolder,
            prompt: 'Run the canary.',
            abortSignal: new AbortController().signal,
            mcpServers: { [REMOTE_SERVER_NAME]: { type: 'http', url: remoteAddress } },
            tools: [{
                name: 'echo',
                description: 'Repeats the text.',
                inputSchema: { text: z.string() },
                handler: (args: Record<string, unknown>) => {
                    echoed.push(String(args.text));

                    return Promise.resolve({ content: [{ type: 'text', text: `echo ${String(args.text)}` }] });
                },
            }],
            reviewToolCall: (call) => {
                reviewed.push(call);
                const isAllowedEcho = call.toolName === `mcp__${PROFILE_SERVER_NAME}__echo` && (call.input as { text?: unknown }).text === 'allowed';
                const isTokenProbe = call.toolName === 'Bash' && (call.input as { command?: unknown }).command === TOKEN_PROBE;
                const isAllowedLookup = call.toolName === `mcp__${REMOTE_SERVER_NAME}__lookup` && (call.input as { query?: unknown }).query === 'allowed';

                return Promise.resolve(isAllowedEcho || isTokenProbe || isAllowedLookup ? { isAllowed: true } : { isAllowed: false, reason: 'The canary refuses this call.' });
            },
        });

        // The events are an async iterator, so `for await` is the only loop form that fits.
        for await (const event of turn) {
            events.push(event);
        }
    }, 120000);

    afterAll(() => {
        model?.close();
        remote?.close();
        void proxy.close();
        void loopback?.close();
        rmSync(folder, { recursive: true, force: true });
    });

    it('offers the model only the command tools and the bot tools, never view_image, web search, helper agents or the prompt tool', () => {
        const tools = requests[0]?.tools ?? [];
        const names = tools.map(tool => tool.name ?? tool.type ?? '');
        const botTools = tools.find(tool => tool.name === `mcp__${PROFILE_SERVER_NAME}`)?.tools?.map(tool => tool.name);

        expect(names.sort())
            .toEqual(EXPECTED_TOOLS);
        expect(botTools)
            .toEqual(EXPECTED_BOT_TOOLS);
    });

    it('runs a bot tool only after the review allows it, and only once', () => {
        const toolCalls = reviewed.filter(call => call.toolName.startsWith(`mcp__${PROFILE_SERVER_NAME}__`));

        expect(toolCalls)
            .toEqual([
                { toolName: `mcp__${PROFILE_SERVER_NAME}__echo`, input: { text: 'refused' } },
                { toolName: `mcp__${PROFILE_SERVER_NAME}__echo`, input: { text: 'allowed' } },
            ]);
        expect(echoed)
            .toEqual(['allowed']);
    });

    it('sends every command and the file edit to the review, and runs none of them', () => {
        const commands = reviewed.filter(call => call.toolName === 'Bash')
            .map(call => (call.input as { command: string }).command)
            .filter(command => command !== TOKEN_PROBE);
        const writes = reviewed.filter(call => call.toolName === 'Write')
            .map(call => (call.input as { file_path: string }).file_path);

        expect(commands)
            .toEqual(COMMANDS);
        expect(writes)
            .toEqual([join(workspaceFolder, PATCHED_FILE)]);
        expect(existsSync(join(workspaceFolder, MARKER_FILE)))
            .toBe(false);
        expect(existsSync(join(workspaceFolder, PATCHED_FILE)))
            .toBe(false);
    });

    it('refuses a view_image call the model makes anyway', () => {
        const lastRequest = requests.at(-1);
        const outputs = lastRequest?.input?.filter(item => item.type === 'function_call_output') ?? [];
        const imageOutput = outputs.find(item => item.call_id === `call_${String(COMMANDS.length + 1)}`)?.output;

        expect(String(imageOutput))
            .toContain('unsupported call: view_image');
    });

    it('keeps the loopback token out of the commands Codex runs', () => {
        const probe = events.find(event => event.type === 'tool_finished' && event.output.startsWith('token='));

        expect(probe)
            .toMatchObject({ output: 'token=\n' });
    });

    it('runs a connected server\'s tool only after the review allows it, and only once', () => {
        const remoteReviews = reviewed.filter(call => call.toolName.startsWith(`mcp__${REMOTE_SERVER_NAME}__`));
        const remoteCalls = remoteReceived.filter(message => message.method === 'tools/call')
            .map(message => message.params?.arguments);

        expect(remoteReviews)
            .toEqual([
                { toolName: `mcp__${REMOTE_SERVER_NAME}__lookup`, input: { query: 'refused' } },
                { toolName: `mcp__${REMOTE_SERVER_NAME}__lookup`, input: { query: 'allowed' } },
            ]);
        expect(remoteCalls)
            .toEqual([{ query: 'allowed' }]);
    });

    it('never lets a resource request reach a connected server', () => {
        const resourceRequests = remoteReceived.filter(message => (message.method ?? '').startsWith('resources/'));
        const methods = remoteReceived.map(message => message.method);

        expect(methods)
            .toContain('tools/list');
        expect(resourceRequests)
            .toEqual([]);
    });

    it('ends the turn normally', () => {
        expect(events.at(-1))
            .toMatchObject({ type: 'turn_finished' });
    });
});
