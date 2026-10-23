import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../createApp.ts';
import { SetupAccess } from './SetupAccess.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { SettingsStore } from '../store/SettingsStore.ts';

describe('the setup route in hub mode', () => {
    let opened: OpenedDatabase | undefined;

    afterEach(() => {
        vi.unstubAllEnvs();
        opened?.close();
        opened = undefined;
    });

    it('returns 404 without redeeming a setup code', async () => {
        opened = await openDatabase(':memory:');
        const access = new SetupAccess(new SettingsStore(opened.db));
        const setupCode = await access.issueSetupCode();

        vi.stubEnv('CLOUDBOT_HUB_SECRET', 'instance-secret');
        vi.stubEnv('CLOUDBOT_HUB_URL', 'http://hub:3001');
        vi.stubEnv('CLOUDBOT_PERSON_NAME', 'maria');
        vi.stubEnv('CLOUDBOT_PERSON_ROLE', 'member');

        const app = createApp({ version: 'test', access, webRoot: 'missing-web-root' });
        const response = await app.request(`/setup?code=${setupCode}`);

        expect(response.status)
            .toBe(404);
        expect(await access.hasSession())
            .toBe(false);
    });
});

export {};
