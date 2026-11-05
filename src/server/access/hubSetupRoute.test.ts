import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../createApp.ts';
import { SetupAccess } from './SetupAccess.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { SettingsStore } from '../store/SettingsStore.ts';

describe('the setup route in hub mode', () => {
    let opened: OpenedDatabase | undefined;

    afterEach(() => {
        opened?.close();
        opened = undefined;
    });

    it('returns 404 without redeeming a setup code', async () => {
        opened = await openDatabase(':memory:');
        const access = new SetupAccess(new SettingsStore(opened.db));
        const setupCode = await access.issueSetupCode();
        const hubConfig = { hubUrl: 'http://hub:3001', secret: 'instance-secret', personName: 'maria', role: 'member' } as const;

        const app = createApp({ version: 'test', access, webRoot: 'missing-web-root', hubConfig });
        const response = await app.request(`/setup?code=${setupCode}`);

        expect(response.status)
            .toBe(404);
        expect(await access.hasSession())
            .toBe(false);
    });
});

export {};
