import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConnectedAppStore } from './ConnectedAppStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';

const CONNECTED_INPUT = {
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    status: 'connected',
    toolCount: 3,
    problem: undefined,
    secretName: 'LINEAR_TOKEN',
    secretBotId: 'bot-1',
} as const;

describe('ConnectedAppStore', () => {
    let opened: OpenedDatabase;
    let store: ConnectedAppStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new ConnectedAppStore(opened.db, { now: () => 1000 });
    });

    afterEach(() => {
        opened.close();
    });

    it('keeps the servers in the order they were connected', async () => {
        await store.save(CONNECTED_INPUT);
        await store.save({ ...CONNECTED_INPUT, name: 'notion' });

        const records = await store.list();

        expect(records.map(record => record.name))
            .toEqual(['linear', 'notion']);
    });

    it('replaces the row of a server that is connected again, and keeps its id', async () => {
        const first = await store.save(CONNECTED_INPUT);
        const second = await store.save({ ...CONNECTED_INPUT, toolCount: 7 });

        expect(second.id)
            .toBe(first.id);
        expect(second.toolCount)
            .toBe(7);
        expect(await store.list())
            .toHaveLength(1);
    });

    it('removes a server by id and reports a missing id', async () => {
        const saved = await store.save(CONNECTED_INPUT);

        expect(await store.remove(saved.id))
            .toBe(true);
        expect(await store.remove(saved.id))
            .toBe(false);
        expect(await store.list())
            .toEqual([]);
    });

    it('stores no token, only the name of the vault secret', async () => {
        await store.save(CONNECTED_INPUT);

        const [record] = await store.list();

        expect(record?.secretName)
            .toBe('LINEAR_TOKEN');
        expect(JSON.stringify(record))
            .not.toContain('Bearer');
    });
});
