import { describe, expect, it } from 'vitest';

import type { ConnectedAppSummary } from '../../shared/connectedApps.ts';
import type { ConnectOutcome } from './ConnectedApps.ts';
import { APP_TOOL_FULL_NAMES, createAppTools } from './createAppTools.ts';

interface ToolResult {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;

function findHandler(tools: unknown[], name: string): ToolHandler {
    const found = (tools as { name: string; handler: unknown }[]).find(candidate => candidate.name === name);

    if (found === undefined) {
        throw new Error(`No tool ${name}`);
    }

    return found.handler as ToolHandler;
}

function textOf(result: ToolResult): string {
    return result.content[0]?.text ?? '';
}

describe('app tools', () => {
    it('names the three tools with the bot server prefix', () => {
        expect(APP_TOOL_FULL_NAMES)
            .toEqual(['mcp__cloudbot__app_connect', 'mcp__cloudbot__app_list', 'mcp__cloudbot__app_remove']);
    });

    it('asks for a token with the site, and says a connected server has its tools', async () => {
        const outcomes: ConnectOutcome[] = [
            { outcome: 'needs_token', name: 'linear', origin: 'https://mcp.linear.app' },
            { outcome: 'connected', name: 'linear', toolCount: 4 },
        ];
        const operations = {
            connect: () => Promise.resolve(outcomes.shift() ?? { outcome: 'failed' as const, problem: 'none' }),
            list: () => Promise.resolve<ConnectedAppSummary[]>([]),
            remove: () => Promise.resolve(false),
        };
        const connect = findHandler(createAppTools(operations, 'bot-1'), 'app_connect');

        expect(textOf(await connect({ name: 'linear', url: 'https://mcp.linear.app/mcp' }, undefined)))
            .toContain('request_secret, for the site https://mcp.linear.app');
        expect(textOf(await connect({ name: 'linear', url: 'https://mcp.linear.app/mcp', tokenSecret: 'LINEAR_TOKEN' }, undefined)))
            .toContain('It has 4 tools');
    });

    it('marks a refusal as an error and passes its problem on', async () => {
        const operations = {
            connect: () => Promise.resolve<ConnectOutcome>({ outcome: 'refused', problem: 'That address is private or reserved.' }),
            list: () => Promise.resolve<ConnectedAppSummary[]>([]),
            remove: () => Promise.resolve(false),
        };
        const connect = findHandler(createAppTools(operations, 'bot-1'), 'app_connect');
        const result = await connect({ name: 'intranet', url: 'https://10.0.0.5/mcp' }, undefined);

        expect(result.isError)
            .toBe(true);
        expect(textOf(result))
            .toBe('That address is private or reserved.');
    });

    it('lists servers without any token, and reports an unknown id on removal', async () => {
        const operations = {
            connect: () => Promise.resolve<ConnectOutcome>({ outcome: 'failed', problem: 'x' }),
            list: () => Promise.resolve<ConnectedAppSummary[]>([{ id: 'app-1', name: 'linear', url: 'https://mcp.linear.app/mcp', status: 'connected', toolCount: 4 }]),
            remove: () => Promise.resolve(false),
        };
        const tools = createAppTools(operations, 'bot-1');

        expect(textOf(await findHandler(tools, 'app_list')({}, undefined)))
            .toBe('- app-1: linear, https://mcp.linear.app/mcp, connected, 4 tools');

        const removed = await findHandler(tools, 'app_remove')({ id: 'missing' }, undefined);

        expect(removed.isError)
            .toBe(true);
    });
});
