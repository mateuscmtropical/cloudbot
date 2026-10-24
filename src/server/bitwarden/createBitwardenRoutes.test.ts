import { describe, expect, it } from 'vitest';

import { BitwardenError } from './BitwardenCli.ts';
import type { BitwardenAccount } from './BitwardenCli.ts';
import { createBitwardenRoutes } from './createBitwardenRoutes.ts';

const PATH = '/api/apps/bitwarden/account';
const BITWARDEN_TEST_PATH = '/api/apps/bitwarden/test';
const CLIENT_ID = 'user.11111111-2222-3333-4444-555555555555';
const CLIENT_SECRET = 'fakeclientsecret0123456789';
const MASTER_PASSWORD = 'fake master password';
const GOOD_BODY = { botId: 'bot-1', serverUrl: '', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, masterPassword: MASTER_PASSWORD };

interface Harness {
    routes: ReturnType<typeof createBitwardenRoutes>;
    accounts: Map<string, BitwardenAccount>;
    forgotten: string[];
}

function setup(testResult: () => Promise<void> = () => Promise.resolve()): Harness {
    const accounts = new Map<string, BitwardenAccount>();
    const forgotten: string[] = [];
    const routes = createBitwardenRoutes({
        vault: {
            status: botId => ({ configured: accounts.has(botId), serverUrl: accounts.get(botId)?.serverUrl ?? '' }),
            save: (botId, account) => {
                accounts.set(botId, account);

                return Promise.resolve();
            },
            forget: (botId) => {
                accounts.delete(botId);
                forgotten.push(botId);

                return Promise.resolve();
            },
            test: testResult,
        },
        hasBot: botId => Promise.resolve(botId === 'bot-1'),
    });

    return { routes, accounts, forgotten };
}

function put(routes: Harness['routes'], value: unknown): Promise<Response> | Response {
    return routes.request(PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}

function postTest(routes: Harness['routes'], value: unknown): Promise<Response> | Response {
    return routes.request(BITWARDEN_TEST_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}

describe('Bitwarden routes', () => {
    it('says no account is saved yet', async () => {
        const { routes } = setup();
        const response = await routes.request(`${PATH}?bot=bot-1`);

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual({ configured: false, serverUrl: '' });
    });

    it('saves the account with the default server and answers without any secret', async () => {
        const { routes, accounts } = setup();
        const response = await put(routes, GOOD_BODY);
        const text = await response.text();

        expect(response.status)
            .toBe(200);
        expect(JSON.parse(text))
            .toEqual({ configured: true, serverUrl: 'https://vault.bitwarden.com' });
        expect(text).not.toContain(CLIENT_SECRET);
        expect(text).not.toContain(MASTER_PASSWORD);
        expect(text).not.toContain(CLIENT_ID);
        expect(accounts.get('bot-1'))
            .toEqual({ serverUrl: 'https://vault.bitwarden.com', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, masterPassword: MASTER_PASSWORD });

        const status = await routes.request(`${PATH}?bot=bot-1`);
        const statusText = await status.text();

        expect(JSON.parse(statusText))
            .toEqual({ configured: true, serverUrl: 'https://vault.bitwarden.com' });
        expect(statusText).not.toContain(CLIENT_SECRET);
    });

    it('takes a custom server address', async () => {
        const { routes, accounts } = setup();

        await put(routes, { ...GOOD_BODY, serverUrl: 'https://vault.bitwarden.eu/' });

        expect(accounts.get('bot-1')?.serverUrl)
            .toBe('https://vault.bitwarden.eu');
    });

    it.each([
        [{ serverUrl: 'http://vault.example.com' }, 'https address'],
        [{ clientId: 'user.bad' }, 'client ID'],
        [{ clientSecret: 'short' }, 'client secret'],
        [{ masterPassword: '' }, 'master password'],
    ])('refuses a bad field %o without echoing any secret', async (change, expected) => {
        const { routes, accounts } = setup();
        const response = await put(routes, { ...GOOD_BODY, ...change });
        const text = await response.text();

        expect(response.status)
            .toBe(400);
        expect(text)
            .toContain(expected);
        expect(text).not.toContain(CLIENT_SECRET);
        expect(text).not.toContain(MASTER_PASSWORD);
        expect(accounts.size)
            .toBe(0);
    });

    it('needs the id of a bot that exists', async () => {
        const { routes } = setup();
        const missing = await put(routes, { ...GOOD_BODY, botId: '' });
        const unknown = await put(routes, { ...GOOD_BODY, botId: 'bot-9' });
        const unknownStatus = await routes.request(`${PATH}?bot=bot-9`);
        const noBot = await routes.request(PATH);
        const notJson = await routes.request(PATH, { method: 'PUT', body: 'x' });

        expect(missing.status)
            .toBe(400);
        expect(unknown.status)
            .toBe(404);
        expect(unknownStatus.status)
            .toBe(404);
        expect(noBot.status)
            .toBe(400);
        expect(notJson.status)
            .toBe(400);
    });

    it('forgets the account', async () => {
        const { routes, accounts, forgotten } = setup();

        await put(routes, GOOD_BODY);

        const response = await routes.request(`${PATH}?bot=bot-1`, { method: 'DELETE' });

        expect(response.status)
            .toBe(204);
        expect(accounts.size)
            .toBe(0);
        expect(forgotten)
            .toEqual(['bot-1']);
        expect((await routes.request(`${PATH}?bot=bot-9`, { method: 'DELETE' })).status)
            .toBe(404);
        expect((await routes.request(PATH, { method: 'DELETE' })).status)
            .toBe(400);
    });

    it('answers ok when the test passes', async () => {
        const { routes } = setup();

        await put(routes, GOOD_BODY);

        const response = await postTest(routes, { botId: 'bot-1' });

        expect(await response.json())
            .toEqual({ ok: true });
    });

    it('answers the plain error when the test fails, and nothing else', async () => {
        const { routes } = setup(() => Promise.reject(new BitwardenError('Bitwarden did not unlock. Check the master password.')));

        await put(routes, GOOD_BODY);

        const response = await postTest(routes, { botId: 'bot-1' });
        const text = await response.text();

        expect(JSON.parse(text))
            .toEqual({ ok: false, error: 'Bitwarden did not unlock. Check the master password.' });
        expect(text).not.toContain(MASTER_PASSWORD);
    });

    it('hides an error that is not from Bitwarden', async () => {
        const { routes } = setup(() => Promise.reject(new Error(`spawn failed with ${MASTER_PASSWORD}`)));

        await put(routes, GOOD_BODY);

        const response = await postTest(routes, { botId: 'bot-1' });
        const text = await response.text();

        expect(JSON.parse(text))
            .toEqual({ ok: false, error: 'The connection test could not run.' });
        expect(text).not.toContain(MASTER_PASSWORD);
    });

    it('says when there is no account to test', async () => {
        const { routes } = setup();
        const response = await postTest(routes, { botId: 'bot-1' });

        expect(await response.json())
            .toEqual({ ok: false, error: 'Bitwarden is not set up for this bot.' });
        expect((await postTest(routes, { botId: 'bot-9' })).status)
            .toBe(404);
        expect((await postTest(routes, {})).status)
            .toBe(400);
    });
});
