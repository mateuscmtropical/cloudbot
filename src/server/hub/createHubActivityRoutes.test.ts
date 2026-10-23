import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { HUB_ACTIVITY_PATH, HUB_TRUST_HEADER } from '../../shared/hubProtocol.ts';
import { SetupAccess } from '../access/SetupAccess.ts';
import { createApp } from '../createApp.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { SettingsStore } from '../store/SettingsStore.ts';
import { createHubActivityRoutes } from './createHubActivityRoutes.ts';
import type { ActivitySources } from './activity.ts';

interface HubEnvironment {
    secret: string | undefined;
    hubUrl: string | undefined;
    personName: string | undefined;
    personRole: string | undefined;
}

function saveHubEnvironment(): HubEnvironment {
    return {
        secret: process.env.CLOUDBOT_HUB_SECRET,
        hubUrl: process.env.CLOUDBOT_HUB_URL,
        personName: process.env.CLOUDBOT_PERSON_NAME,
        personRole: process.env.CLOUDBOT_PERSON_ROLE,
    };
}

function restoreHubEnvironment(environment: HubEnvironment): void {
    if (environment.secret === undefined) {
        delete process.env.CLOUDBOT_HUB_SECRET;
    } else {
        process.env.CLOUDBOT_HUB_SECRET = environment.secret;
    }

    if (environment.hubUrl === undefined) {
        delete process.env.CLOUDBOT_HUB_URL;
    } else {
        process.env.CLOUDBOT_HUB_URL = environment.hubUrl;
    }

    if (environment.personName === undefined) {
        delete process.env.CLOUDBOT_PERSON_NAME;
    } else {
        process.env.CLOUDBOT_PERSON_NAME = environment.personName;
    }

    if (environment.personRole === undefined) {
        delete process.env.CLOUDBOT_PERSON_ROLE;
    } else {
        process.env.CLOUDBOT_PERSON_ROLE = environment.personRole;
    }
}

function readSessionToken(response: Response): string {
    const setCookieHeader = response.headers.get('set-cookie') ?? '';
    const match = /cloudbot_session=([^;]+)/.exec(setCookieHeader);
    const sessionToken = match?.[1];

    if (sessionToken === undefined) {
        throw new Error('The setup link did not set a session cookie.');
    }

    return sessionToken;
}

describe('createHubActivityRoutes', () => {
    it('answers the hub activity path with the computed activity', async () => {
        const sources: ActivitySources = {
            hasActiveTurn: true,
            hasEnabledRoutine: false,
            hasEnabledWatch: false,
            hasWebhook: false,
            hasWhatsAppConnection: false,
            hasTelegramConnection: false,
            hasEmailAccount: false,
            isLoginOrSetupInProgress: false,
        };
        const readSources = vi.fn(() => Promise.resolve(sources));
        const app = new Hono();
        const routes = createHubActivityRoutes({ readSources });

        app.route('/', routes);

        const response = await app.request(HUB_ACTIVITY_PATH);

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual({ isBusy: true, reasons: ['turn running or queued'] });
        expect(readSources)
            .toHaveBeenCalledOnce();
    });

    it('mounts the route only in hub mode and protects it with the app session check', async () => {
        const originalEnvironment = saveHubEnvironment();
        const database = await openDatabase(':memory:');
        const access = new SetupAccess(new SettingsStore(database.db));

        try {
            process.env.CLOUDBOT_HUB_SECRET = 'hub-secret';
            process.env.CLOUDBOT_HUB_URL = 'http://hub:3001';
            process.env.CLOUDBOT_PERSON_NAME = 'maria';
            process.env.CLOUDBOT_PERSON_ROLE = 'member';

            const hubApp = createApp({ version: '1.2.3', access, hubSecret: 'hub-secret' });
            const denied = await hubApp.request(HUB_ACTIVITY_PATH);
            const authorized = await hubApp.request(HUB_ACTIVITY_PATH, {
                headers: { [HUB_TRUST_HEADER]: 'hub-secret' },
            });

            expect(denied.status)
                .toBe(401);
            expect(authorized.status)
                .toBe(200);
            expect(await authorized.json())
                .toEqual({ isBusy: false, reasons: [] });

            delete process.env.CLOUDBOT_HUB_SECRET;
            delete process.env.CLOUDBOT_HUB_URL;
            delete process.env.CLOUDBOT_PERSON_NAME;
            delete process.env.CLOUDBOT_PERSON_ROLE;

            const standaloneApp = createApp({ version: '1.2.3', access });
            const setupCode = await access.issueSetupCode();
            const signIn = await standaloneApp.request(`/setup?code=${setupCode}`);
            const sessionToken = readSessionToken(signIn);
            const notMounted = await standaloneApp.request(HUB_ACTIVITY_PATH, {
                headers: { cookie: `cloudbot_session=${sessionToken}` },
            });

            expect(notMounted.status)
                .toBe(404);
        } finally {
            database.close();
            restoreHubEnvironment(originalEnvironment);
        }
    });
});
