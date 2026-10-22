import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentEvent } from './AgentEvent.ts';
import type { ToolCall } from './AgentRunner.ts';
import { CodexEngine } from './CodexEngine.ts';
import { CODEX_PROTOCOL_VERSION } from './codexProtocol.ts';

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
const MODEL_CALLS = [
    ...COMMANDS.map(command => ({ name: 'exec_command', arguments: JSON.stringify({ cmd: command }) })),
    { name: 'exec_command', arguments: JSON.stringify({ cmd: `apply_patch <<'EOF'\n${PATCH}EOF\n` }) },
    { name: 'view_image', arguments: JSON.stringify({ path: '/etc/hostname' }) },
];
// The only tools Codex may offer the model with the locked config. view_image, web search and helper agents are off.
const EXPECTED_TOOLS = ['exec_command', 'request_user_input', 'write_stdin'];
const USAGE = { input_tokens: 5, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 10 };

interface ModelRequest {
    tools?: { name?: string; type?: string }[];
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

describe.skipIf(CODEX_PATH === '')(`Codex canary (checked with ${CODEX_PROTOCOL_VERSION})`, () => {
    const requests: ModelRequest[] = [];
    const reviewed: ToolCall[] = [];
    const events: AgentEvent[] = [];
    const folder = mkdtempSync(join(tmpdir(), 'cloudbot-codex-canary-'));
    const workspaceFolder = mkdtempSync(join(folder, 'workspace-'));
    let model: { url: string; close: () => void } | undefined;

    beforeAll(async () => {
        model = await startFakeModel(requests);
        const engine = new CodexEngine({
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
            reviewToolCall: (call) => {
                reviewed.push(call);

                return Promise.resolve({ isAllowed: false, reason: 'The canary refuses every call.' });
            },
        });

        // The events are an async iterator, so `for await` is the only loop form that fits.
        for await (const event of turn) {
            events.push(event);
        }
    }, 120000);

    afterAll(() => {
        model?.close();
        rmSync(folder, { recursive: true, force: true });
    });

    it('offers the model only the command tools, never view_image, web search or helper agents', () => {
        const names = requests[0]?.tools?.map(tool => tool.name ?? tool.type ?? '') ?? [];

        expect(names.sort())
            .toEqual(EXPECTED_TOOLS);
    });

    it('sends every command and the file edit to the review, and runs none of them', () => {
        const commands = reviewed.filter(call => call.toolName === 'Bash')
            .map(call => (call.input as { command: string }).command);
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
        const imageOutput = outputs.at(-1)?.output;

        expect(String(imageOutput))
            .toContain('unsupported call: view_image');
    });

    it('ends the turn normally', () => {
        expect(events.at(-1))
            .toMatchObject({ type: 'turn_finished' });
    });
});
