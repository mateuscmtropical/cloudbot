import { describe, expect, it } from 'vitest';

import type { BrowserAllowRecord, BrowserAllowStore } from '../store/BrowserAllowStore.ts';
import { BROWSER_ALLOW_TOOL_FULL_NAMES, createBrowserAllowTools } from './createBrowserAllowTools.ts';

interface ToolResult {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;
type StoreOperations = Pick<BrowserAllowStore, 'add' | 'list' | 'remove'>;

// An in-memory store with the rows the tools write.
function createFakeStore(): { store: StoreOperations; rows: BrowserAllowRecord[] } {
    const rows: BrowserAllowRecord[] = [];
    const store: StoreOperations = {
        add: (host, port) => {
            const record: BrowserAllowRecord = { id: `id-${String(rows.length + 1)}`, host, port: port ?? 0, createdAt: 0 };

            rows.push(record);

            return Promise.resolve(record);
        },
        list: () => Promise.resolve([...rows]),
        remove: (id) => {
            const index = rows.findIndex(row => row.id === id);

            if (index === -1) {
                return Promise.resolve(false);
            }

            rows.splice(index, 1);

            return Promise.resolve(true);
        },
    };

    return { store, rows };
}

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

describe('browser allow tools', () => {
    it.each([
        ['localhost', 'localhost'],
        ['a name under localhost', 'api.localhost'],
        ['loopback', '127.0.0.1'],
        ['the unspecified address', '0.0.0.0'],
        ['the cloud metadata address', '169.254.169.254'],
        ['the IPv6 loopback in brackets', '[::1]'],
        ['the IPv6 metadata address', 'fd00:ec2::254'],
    ])('refuses %s at once and saves nothing', async (_name, host) => {
        const { store, rows } = createFakeStore();
        const allow = findHandler(createBrowserAllowTools(store), 'browser_allow_host');
        const result = await allow({ host }, undefined);

        expect(result.isError)
            .toBe(true);
        expect(textOf(result))
            .toContain('never reaches this host');
        expect(rows)
            .toEqual([]);
    });

    it('allows a private address literal', async () => {
        const { store, rows } = createFakeStore();
        const allow = findHandler(createBrowserAllowTools(store), 'browser_allow_host');
        const result = await allow({ host: '10.0.0.5' }, undefined);

        expect(result.isError)
            .toBeUndefined();
        expect(rows)
            .toHaveLength(1);
    });

    it('allows a host with a port, normalized, and says so', async () => {
        const { store, rows } = createFakeStore();
        const tools = createBrowserAllowTools(store);
        const allow = findHandler(tools, 'browser_allow_host');
        const result = await allow({ host: ' Intranet.Test. ', port: 8080 }, undefined);

        expect(textOf(result))
            .toContain('intranet.test, port 8080');
        expect(rows[0])
            .toMatchObject({ host: 'intranet.test', port: 8080 });
    });

    it('allows every port when no port is given', async () => {
        const { store, rows } = createFakeStore();
        const allow = findHandler(createBrowserAllowTools(store), 'browser_allow_host');

        await allow({ host: '10.0.0.5' }, undefined);

        expect(rows[0])
            .toMatchObject({ host: '10.0.0.5', port: 0 });
    });

    it('refuses text that is not a host, and stores nothing', async () => {
        const { store, rows } = createFakeStore();
        const allow = findHandler(createBrowserAllowTools(store), 'browser_allow_host');
        const result = await allow({ host: 'http://intranet.test/admin' }, undefined);

        expect(result.isError)
            .toBe(true);
        expect(rows)
            .toHaveLength(0);
    });

    it('lists the allowed hosts, and says when there are none', async () => {
        const { store } = createFakeStore();
        const tools = createBrowserAllowTools(store);
        const list = findHandler(tools, 'browser_allowed_hosts');
        const allow = findHandler(tools, 'browser_allow_host');

        expect(textOf(await list({}, undefined)))
            .toBe('No private hosts are allowed.');

        await allow({ host: '10.0.0.5' }, undefined);
        await allow({ host: 'intranet.test', port: 80 }, undefined);

        expect(textOf(await list({}, undefined)))
            .toContain('10.0.0.5, every port');
        expect(textOf(await list({}, undefined)))
            .toContain('intranet.test, port 80');
    });

    it('removes a host by id, and reports an unknown id as an error', async () => {
        const { store, rows } = createFakeStore();
        const tools = createBrowserAllowTools(store);
        const allow = findHandler(tools, 'browser_allow_host');
        const remove = findHandler(tools, 'browser_remove_host');

        await allow({ host: '10.0.0.5' }, undefined);

        const removed = await remove({ id: rows[0]?.id ?? '' }, undefined);
        const missing = await remove({ id: 'no-such-id' }, undefined);

        expect(removed.isError)
            .toBeUndefined();
        expect(missing.isError)
            .toBe(true);
        expect(rows)
            .toHaveLength(0);
    });

    it('names the three tools with the cloudbot server prefix', () => {
        expect(BROWSER_ALLOW_TOOL_FULL_NAMES)
            .toEqual([
                'mcp__cloudbot__browser_allow_host',
                'mcp__cloudbot__browser_allowed_hosts',
                'mcp__cloudbot__browser_remove_host',
            ]);
    });
});
