import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

import type { ToolCallDecision } from './AgentRunner.ts';
import type { LoopbackTool, LoopbackToolServer, LoopbackTurn, LoopbackTurnGrant } from './createLoopbackToolServer.ts';
import { startLoopbackToolServer } from './createLoopbackToolServer.ts';

const SERVER_NAME = 'cloudbot';
const TOOL_CALL_ID = 'toolu_seen_1';

function echoTool(): LoopbackTool {
    return {
        name: 'echo',
        description: 'Repeats the text.',
        inputSchema: { text: z.string() },
        handler: (args: Record<string, unknown>) => Promise.resolve({ content: [{ type: 'text', text: `echo ${String(args.text)}` }] }),
    };
}

// The config files of a turn name the URL and the token, so the tests read them like the CLI does.
function mcpUrlAndHeaders(turn: LoopbackTurn): { url: string; authorization: string } {
    const config = JSON.parse(readFileSync(turn.mcpConfigPath, 'utf8')) as { mcpServers: Record<string, { url: string; headers: { Authorization: string } }> };
    const entry = config.mcpServers[SERVER_NAME];

    return { url: entry?.url ?? '', authorization: entry?.headers.Authorization ?? '' };
}

async function postMcp(turn: LoopbackTurn, body: unknown): Promise<{ status: number; json: unknown }> {
    const mcp = mcpUrlAndHeaders(turn);
    const response = await fetch(mcp.url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'authorization': mcp.authorization },
    });
    const text = await response.text();

    return { status: response.status, json: text === '' ? undefined : JSON.parse(text) };
}

function toolCall(name: string, args: unknown, toolUseId: string | undefined): unknown {
    const meta = toolUseId === undefined ? undefined : { 'claudecode/toolUseId': toolUseId };

    return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: meta } };
}

// Sends a request whose target is sent as is, so odd paths reach the server unchanged.
function statusOfRawPath(base: URL, path: string, authorization: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: base.hostname, port: base.port, path, method: 'POST', headers: { authorization } }, (res) => {
            res.resume();
            res.on('end', () => {
                resolve(res.statusCode ?? 0);
            });
        });

        req.on('error', reject);
        req.end('{}');
    });
}

function promptCall(args: unknown): unknown {
    return { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve', arguments: args } };
}

function resultText(json: unknown): unknown {
    const result = (json as { result: { content: { text: string }[] } }).result;

    return JSON.parse(result.content[0]?.text ?? 'null');
}

function allowingReview(): LoopbackTurnGrant['reviewToolCall'] {
    return vi.fn((): Promise<ToolCallDecision> => Promise.resolve({ isAllowed: true }));
}

describe('loopback tool server', () => {
    let server: LoopbackToolServer;

    beforeEach(async () => {
        server = await startLoopbackToolServer(SERVER_NAME);
    });

    afterEach(async () => {
        await server.close();
    });

    it('denies a prompt for a call the CLI never reported on its stdout', async () => {
        const review = allowingReview();
        const turn = server.grantTurn({ tools: [], reviewToolCall: review });

        const response = await postMcp(turn, promptCall({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_unknown' }));

        expect(resultText(response.json))
            .toEqual({ behavior: 'deny', message: 'The CLI did not report this call, so it was not run.' });
        expect(review)
            .not.toHaveBeenCalled();
        turn.release();
    });

    it('allows a reported call once, and runs its tool call once with that decision', async () => {
        const handler = vi.fn((args: Record<string, unknown>) => Promise.resolve({ content: [{ type: 'text', text: `echo ${String(args.text)}` }] }));
        const turn = server.grantTurn({ tools: [{ ...echoTool(), handler }], reviewToolCall: allowingReview() });

        turn.noteToolUse(TOOL_CALL_ID, 'mcp__cloudbot__echo', { text: 'hi' });
        const prompt = await postMcp(turn, promptCall({ tool_name: 'mcp__cloudbot__echo', input: { text: 'hi' }, tool_use_id: TOOL_CALL_ID }));
        const first = await postMcp(turn, toolCall('echo', { text: 'hi' }, TOOL_CALL_ID));
        const second = await postMcp(turn, toolCall('echo', { text: 'hi' }, TOOL_CALL_ID));

        expect(resultText(prompt.json))
            .toEqual({ behavior: 'allow', updatedInput: { text: 'hi' } });
        expect(handler)
            .toHaveBeenCalledTimes(1);
        expect(JSON.stringify(first.json))
            .toContain('echo hi');
        expect(JSON.stringify(second.json))
            .toContain('not approved');
        turn.release();
    });

    it('refuses a tool call without the tool use id, even after an allow', async () => {
        const handler = vi.fn(() => Promise.resolve({ content: [] }));
        const turn = server.grantTurn({ tools: [{ ...echoTool(), handler }], reviewToolCall: allowingReview() });

        turn.noteToolUse(TOOL_CALL_ID, 'mcp__cloudbot__echo', { text: 'hi' });
        await postMcp(turn, promptCall({ tool_name: 'mcp__cloudbot__echo', input: { text: 'hi' }, tool_use_id: TOOL_CALL_ID }));
        const response = await postMcp(turn, toolCall('echo', { text: 'hi' }, undefined));

        expect(JSON.stringify(response.json))
            .toContain('not approved');
        expect(handler)
            .not.toHaveBeenCalled();
        turn.release();
    });

    it('denies a prompt whose name or input differs from the one the CLI reported', async () => {
        const review = allowingReview();
        const turn = server.grantTurn({ tools: [], reviewToolCall: review });

        turn.noteToolUse(TOOL_CALL_ID, 'Bash', { command: 'ls' });
        const response = await postMcp(turn, promptCall({ tool_name: 'Bash', input: { command: 'rm -rf x' }, tool_use_id: TOOL_CALL_ID }));

        expect(resultText(response.json))
            .toMatchObject({ behavior: 'deny' });
        expect(review)
            .not.toHaveBeenCalled();
        turn.release();
    });

    it('decides one tool use once: a repeated prompt is refused and not reviewed again', async () => {
        const review = allowingReview();
        const turn = server.grantTurn({ tools: [], reviewToolCall: review });
        const args = { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: TOOL_CALL_ID };

        turn.noteToolUse(TOOL_CALL_ID, 'Bash', { command: 'ls' });
        const first = await postMcp(turn, promptCall(args));
        const second = await postMcp(turn, promptCall(args));

        expect(resultText(first.json))
            .toMatchObject({ behavior: 'allow' });
        expect(resultText(second.json))
            .toMatchObject({ behavior: 'deny' });
        expect(review)
            .toHaveBeenCalledTimes(1);
        turn.release();
    });

    it('decides a tool use once when two prompts for it arrive together', async () => {
        const review = vi.fn(async (): Promise<ToolCallDecision> => {
            await new Promise(resolve => setTimeout(resolve, 30));

            return { isAllowed: true };
        });
        const turn = server.grantTurn({ tools: [], reviewToolCall: review });
        const args = promptCall({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: TOOL_CALL_ID });

        turn.noteToolUse(TOOL_CALL_ID, 'Bash', { command: 'ls' });
        const [first, second] = await Promise.all([postMcp(turn, args), postMcp(turn, args)]);
        const behaviors = [first, second].map(response => (resultText(response.json) as { behavior: string }).behavior)
            .sort();

        expect(behaviors)
            .toEqual(['allow', 'deny']);
        expect(review)
            .toHaveBeenCalledTimes(1);
        turn.release();
    });

    it('refuses a prompt whose tool is the permission tool itself, without a review', async () => {
        const review = allowingReview();
        const turn = server.grantTurn({ tools: [], reviewToolCall: review });

        turn.noteToolUse(TOOL_CALL_ID, 'mcp__cloudbot__approve', {});
        const response = await postMcp(turn, promptCall({ tool_name: 'mcp__cloudbot__approve', input: {}, tool_use_id: TOOL_CALL_ID }));

        expect(resultText(response.json))
            .toMatchObject({ behavior: 'deny' });
        expect(review)
            .not.toHaveBeenCalled();
        turn.release();
    });

    it('matches the Agent name of a prompt to the Task the CLI printed', async () => {
        const turn = server.grantTurn({ tools: [], reviewToolCall: allowingReview() });

        turn.noteToolUse(TOOL_CALL_ID, 'Task', { subagent_type: 'reader' });
        const response = await postMcp(turn, promptCall({ tool_name: 'Agent', input: { subagent_type: 'reader' }, tool_use_id: TOOL_CALL_ID }));

        expect(resultText(response.json))
            .toMatchObject({ behavior: 'allow' });
        turn.release();
    });

    it('denies a tool the owner blocked, without a review', async () => {
        const review = allowingReview();
        const turn = server.grantTurn({ tools: [], reviewToolCall: review, disallowedTools: ['Bash'] });

        turn.noteToolUse(TOOL_CALL_ID, 'Bash', { command: 'ls' });
        const response = await postMcp(turn, promptCall({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: TOOL_CALL_ID }));

        expect(resultText(response.json))
            .toMatchObject({ behavior: 'deny' });
        expect(review)
            .not.toHaveBeenCalled();
        turn.release();
    });

    it('answers a deny for every failure of the prompt, never an error status', async () => {
        const turn = server.grantTurn({ tools: [], reviewToolCall: () => Promise.reject(new Error('review broke')) });

        turn.noteToolUse(TOOL_CALL_ID, 'Bash', { command: 'ls' });
        const thrown = await postMcp(turn, promptCall({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: TOOL_CALL_ID }));
        const malformed = await postMcp(turn, promptCall({ tool_name: 42 }));

        expect(thrown.status)
            .toBe(200);
        expect(resultText(thrown.json))
            .toMatchObject({ behavior: 'deny' });
        expect(malformed.status)
            .toBe(200);
        expect(resultText(malformed.json))
            .toMatchObject({ behavior: 'deny' });
        turn.release();
    });

    it('gives a turn released during the review no allowance, so the call does not run', async () => {
        const handler = vi.fn(() => Promise.resolve({ content: [] }));
        let releaseTurn: () => void = () => undefined;
        const turn = server.grantTurn({
            tools: [{ ...echoTool(), handler }],
            reviewToolCall: () => {
                releaseTurn();

                return Promise.resolve({ isAllowed: true });
            },
        });

        releaseTurn = () => {
            turn.release();
        };
        turn.noteToolUse(TOOL_CALL_ID, 'mcp__cloudbot__echo', { text: 'hi' });
        const response = await postMcp(turn, promptCall({ tool_name: 'mcp__cloudbot__echo', input: { text: 'hi' }, tool_use_id: TOOL_CALL_ID }));

        expect(resultText(response.json))
            .toMatchObject({ behavior: 'deny' });
        expect(handler)
            .not.toHaveBeenCalled();
    });

    it('refuses a released turn at once', async () => {
        const turn = server.grantTurn({ tools: [echoTool()], reviewToolCall: allowingReview() });
        const mcp = mcpUrlAndHeaders(turn);

        turn.release();
        const response = await fetch(mcp.url, { method: 'POST', body: JSON.stringify(toolCall('echo', {}, TOOL_CALL_ID)), headers: { authorization: mcp.authorization } });

        expect(response.status)
            .toBe(200);
        expect(await response.text())
            .toContain('not known');
    });

    it('waits briefly for a tool_use line that arrives just after the prompt', async () => {
        const turn = server.grantTurn({ tools: [], reviewToolCall: allowingReview() });
        const pending = postMcp(turn, promptCall({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: TOOL_CALL_ID }));

        setTimeout(() => {
            turn.noteToolUse(TOOL_CALL_ID, 'Bash', { command: 'ls' });
        }, 50);

        expect(resultText((await pending).json))
            .toMatchObject({ behavior: 'allow' });
        turn.release();
    });

    it('refuses a request with an Origin header, and one whose Host is another name', async () => {
        const turn = server.grantTurn({ tools: [], reviewToolCall: allowingReview() });
        const mcp = mcpUrlAndHeaders(turn);
        const withOrigin = await fetch(mcp.url, {
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
            headers: { authorization: mcp.authorization, origin: 'https://evil.example' },
        });
        const url = new URL(mcp.url);
        const withHost = await new Promise<number>((resolve, reject) => {
            const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { host: 'localhost.example:1', authorization: mcp.authorization } }, (res) => {
                res.resume();
                res.on('end', () => {
                    resolve(res.statusCode ?? 0);
                });
            });

            req.on('error', reject);
            req.end('{}');
        });

        expect(withOrigin.status)
            .toBe(403);
        expect(withHost)
            .toBe(403);
        turn.release();
    });

    it('answers 404 to the odd paths that URL parsing used to crash on, and keeps serving', async () => {
        const turn = server.grantTurn({ tools: [], reviewToolCall: allowingReview() });
        const mcp = mcpUrlAndHeaders(turn);
        const base = new URL(mcp.url);
        const paths = ['//', '//[', '/mcp/../x', '//mcp'];
        const statuses = await Promise.all(paths.map(path => statusOfRawPath(base, path, mcp.authorization)));

        expect(statuses)
            .toEqual([404, 404, 404, 404]);
        expect((await postMcp(turn, { jsonrpc: '2.0', id: 1, method: 'ping' })).status)
            .toBe(200);
        turn.release();
    });

    it('writes the permission rules with every built-in and the MCP servers, and no hook', () => {
        const turn = server.grantTurn({ tools: [], reviewToolCall: allowingReview(), remoteServers: { linear: { type: 'http', url: 'https://mcp.example' } } });
        const config = JSON.parse(readFileSync(turn.mcpConfigPath, 'utf8')) as { mcpServers: Record<string, unknown> };
        const settings = JSON.parse(readFileSync(turn.settingsPath, 'utf8')) as { permissions: { ask: string[] }; hooks?: unknown };

        expect(Object.keys(config.mcpServers))
            .toEqual(['linear', SERVER_NAME]);
        expect(settings.permissions.ask)
            .toEqual(expect.arrayContaining(['Bash', 'Read', 'Task', 'Agent', 'mcp__cloudbot', 'mcp__linear']));
        expect(settings.hooks)
            .toBeUndefined();
        turn.release();
    });

    it('writes a file into the turn folder and removes the folder on release', () => {
        const turn = server.grantTurn({ tools: [], reviewToolCall: allowingReview() });
        const folder = turn.folder;
        const path = turn.writeFile('system-prompt.txt', 'You are the bot.');

        expect(readFileSync(path, 'utf8'))
            .toBe('You are the bot.');
        expect(existsSync(folder))
            .toBe(true);
        turn.release();
        expect(existsSync(folder))
            .toBe(false);
    });

    it.skipIf(process.platform === 'win32')('gives the agent group read access only, with the setgid bit kept on the folder', async () => {
        const root = join(process.cwd(), 'node_modules', '.cache', 'loopback-root-test');
        const readable = await startLoopbackToolServer(SERVER_NAME, { turnRoot: root, agentReadable: true });
        const turn = readable.grantTurn({ tools: [], reviewToolCall: allowingReview() });

        expect(statSync(turn.folder).mode & 0o7777)
            .toBe(0o2750);
        expect(statSync(turn.mcpConfigPath).mode & 0o777)
            .toBe(0o640);
        expect(statSync(root).mode & 0o7777)
            .toBe(0o2710);
        turn.release();
        await readable.close();
        rmSync(root, { recursive: true, force: true });
    });
});
