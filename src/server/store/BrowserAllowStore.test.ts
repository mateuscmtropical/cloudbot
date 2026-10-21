import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BrowserAllowStore } from './BrowserAllowStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';

describe('BrowserAllowStore', () => {
    let opened: OpenedDatabase;
    let store: BrowserAllowStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new BrowserAllowStore(opened.db, { now: () => 1000 });
    });

    afterEach(() => {
        opened.close();
    });

    it('keeps the hosts it is given in the order they were added', async () => {
        await store.add('intranet.test', 8080);
        await store.add('10.0.0.5', undefined);

        const records = await store.list();

        expect(records.map(record => [record.host, record.port]))
            .toEqual([['intranet.test', 8080], ['10.0.0.5', 0]]);
    });

    it('keeps one row when the same host and port are added twice', async () => {
        await store.add('intranet.test', 8080);
        await store.add('intranet.test', 8080);

        expect(await store.list())
            .toHaveLength(1);
    });

    it('allows only the port it was given, or every port when it has none', async () => {
        await store.add('intranet.test', 8080);
        await store.add('10.0.0.5', undefined);

        expect(await store.isAllowed('intranet.test', 8080))
            .toBe(true);
        expect(await store.isAllowed('intranet.test', 443))
            .toBe(false);
        expect(await store.isAllowed('10.0.0.5', 443))
            .toBe(true);
        expect(await store.isAllowed('10.0.0.6', 443))
            .toBe(false);
    });

    it('removes a host by id, and a second removal finds nothing', async () => {
        const record = await store.add('intranet.test', undefined);

        expect(await store.remove(record.id))
            .toBe(true);
        expect(await store.remove(record.id))
            .toBe(false);
        expect(await store.isAllowed('intranet.test', 80))
            .toBe(false);
    });
});
