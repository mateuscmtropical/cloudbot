import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

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
];
// The only tools Codex may offer the model with the locked config. view_image, web search and helper agents are off.
// With an MCP server Codex adds the resource tools, which have no approval. The loopback server has no resources.
const EXPECTED_TOOLS = ['exec_command', 'list_mcp_resource_templates', 'list_mcp_resources', `mcp__${PROFILE_SERVER_NAME}`, 'read_mcp_resource', 'request_user_input', 'write_stdin'];
const EXPECTED_BOT_TOOLS = ['echo'];
// A 1 by 1 PNG, attached to the canary turn.
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const USAGE = { input_tokens: 5, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 10 };

interface ModelRequest {
    tools?: { name?: string; type?: string; tools?: { name: string }[] }[];
    input?: { type?: string; call_id?: string; output?: unknown; content?: { type?: string; image_url?: string }[] }[];
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

describe.skipIf(CODEX_PATH === '')(`Codex canary (checked with ${CODEX_PROTOCOL_VERSION})`, () => {
    const requests: ModelRequest[] = [];
    const reviewed: ToolCall[] = [];
    const events: AgentEvent[] = [];
    const folder = mkdtempSync(join(tmpdir(), 'cloudbot-codex-canary-'));
    const workspaceFolder = mkdtempSync(join(folder, 'workspace-'));
    let model: { url: string; close: () => void } | undefined;
    let loopback: LoopbackToolServer | undefined;
    const echoed: string[] = [];

    beforeAll(async () => {
        model = await startFakeModel(requests);
        loopback = await startLoopbackToolServer(PROFILE_SERVER_NAME);
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
            images: [{ mediaType: 'image/png', data: ONE_PIXEL_PNG }],
            abortSignal: new AbortController().signal,
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

                return Promise.resolve(isAllowedEcho || isTokenProbe ? { isAllowed: true } : { isAllowed: false, reason: 'The canary refuses this call.' });
            },
        });

        // The events are an async iterator, so `for await` is the only loop form that fits.
        for await (const event of turn) {
            events.push(event);
        }
    }, 120000);

    afterAll(() => {
        model?.close();
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
        const toolCalls = reviewed.filter(call => call.toolName.startsWith('mcp__'));

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

    it('sends the attached image to the model', () => {
        const parts = requests[0]?.input?.flatMap(item => item.content ?? []) ?? [];
        const image = parts.find(part => part.type === 'input_image');

        expect(image?.image_url)
            .toBe(`data:image/png;base64,${ONE_PIXEL_PNG}`);
    });

    it('ends the turn normally', () => {
        expect(events.at(-1))
            .toMatchObject({ type: 'turn_finished' });
    });
});
