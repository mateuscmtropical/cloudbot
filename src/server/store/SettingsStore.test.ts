import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';
import { SettingsStore } from './SettingsStore.ts';

describe('SettingsStore', () => {
    let opened: OpenedDatabase;
    let store: SettingsStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new SettingsStore(opened.db);
    });

    afterEach(() => {
        opened.close();
    });

    it('returns undefined for a setting that was never written', async () => {
        await expect(store.get('language'))
            .resolves.toBeUndefined();
    });

    it('reads back a written setting', async () => {
        await store.set('language', 'pt-BR');

        await expect(store.get('language'))
            .resolves.toBe('pt-BR');
    });

    it('overwrites an existing setting', async () => {
        await store.set('language', 'pt-BR');
        await store.set('language', 'en');

        await expect(store.get('language'))
            .resolves.toBe('en');
    });
});
