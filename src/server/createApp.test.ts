import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SetupAccess } from './access/SetupAccess.ts';
import { FakeAgentRunner } from './agent/FakeAgentRunner.ts';
import { ChatService } from './chat/ChatService.ts';
import { createApp } from './createApp.ts';
import { RuleStore } from './store/RuleStore.ts';
import { BotStore } from './store/BotStore.ts';
import { MessageStore } from './store/MessageStore.ts';
import type { OpenedDatabase } from './store/openDatabase.ts';
import { openDatabase } from './store/openDatabase.ts';
import { SettingsStore } from './store/SettingsStore.ts';

const createdDirectories: string[] = [];

async function createWebRoot(): Promise<string> {
    const webRoot = await mkdtemp(join(tmpdir(), 'cloudbot-web-'));
    const assetsDirectory = join(webRoot, 'assets');

    createdDirectories.push(webRoot);
    await mkdir(assetsDirectory);
    await writeFile(join(webRoot, 'index.html'), '<div id="root"></div>');
    await writeFile(join(assetsDirectory, 'app.js'), 'console.log(1);');

    return webRoot;
}

function readSessionCookie(response: Response): string | undefined {
    const setCookieHeader = response.headers.get('set-cookie') ?? '';
    const match = /cloudbot_session=([^;]+)/.exec(setCookieHeader);

    return match?.[1];
}

// No turn runs in these tests, so the data folder is never created.
function buildChatService(database: OpenedDatabase): ChatService {
    const runner = new FakeAgentRunner([]);

    return new ChatService({
        botStore: new BotStore(database.db),
        messageStore: new MessageStore(database.db),
        runner,
        dataDir: join(tmpdir(), 'cloudbot-app-test'),
    });
}

function requestWithSession(app: Hono, path: string, sessionToken: string | undefined): Response | Promise<Response> {
    return app.request(path, {
        headers: { cookie: `cloudbot_session=${sessionToken ?? ''}` },
    });
}

async function signIn(app: Hono, access: SetupAccess): Promise<string> {
    const setupCode = await access.issueSetupCode();
    const response = await app.request(`/setup?code=${setupCode}`);
    const sessionToken = readSessionCookie(response);

    if (sessionToken === undefined) {
        throw new Error('The setup link did not set a session cookie.');
    }

    return sessionToken;
}

describe('createApp', () => {
    let opened: OpenedDatabase;
    let access: SetupAccess;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        access = new SetupAccess(new SettingsStore(opened.db));
    });

    afterEach(async () => {
        opened.close();

        const directories = createdDirectories.splice(0);

        await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
    });

    it('answers the health route with the version and no cookie', async () => {
        const app = createApp({ version: '1.2.3', access });
        const response = await app.request('/api/health');

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual({ status: 'ok', version: '1.2.3' });
    });

    it('answers unknown api routes with 404 when the session is valid', async () => {
        const app = createApp({ version: '1.2.3', access });
        const sessionToken = await signIn(app, access);
        const response = await requestWithSession(app, '/api/missing', sessionToken);

        expect(response.status)
            .toBe(404);
    });

    it('rejects an api request without the cookie', async () => {
        const app = createApp({ version: '1.2.3', access });
        const response = await app.request('/api/missing');

        expect(response.status)
            .toBe(401);
    });

    it('rejects the chat routes and the event stream without the cookie', async () => {
        const chatService = buildChatService(opened);
        const app = createApp({ version: '1.2.3', access, chatService });
        const listResponse = await app.request('/api/bots');
        const eventsResponse = await app.request('/api/bots/any/events');

        expect(listResponse.status)
            .toBe(401);
        expect(eventsResponse.status)
            .toBe(401);
    });

    it('serves the chat routes with a valid session cookie', async () => {
        const chatService = buildChatService(opened);
        const app = createApp({ version: '1.2.3', access, chatService });
        const sessionToken = await signIn(app, access);
        const response = await requestWithSession(app, '/api/bots', sessionToken);

        expect(response.status)
            .toBe(200);
    });

    it('lets the owner list, add and remove a bot\'s rules, and refuses them without the cookie', async () => {
        const chatService = buildChatService(opened);
        const ruleStore = new RuleStore(opened.db);
        const bot = await new BotStore(opened.db)
            .create({ name: 'Ana', title: 'Assistant', description: '' });
        const app = createApp({ version: '1.2.3', access, chatService, ruleStore });
        const sessionToken = await signIn(app, access);
        const cookie = `cloudbot_session=${sessionToken}`;
        const withoutCookie = await app.request(`/api/bots/${bot.id}/rules`);
        const added = await app.request(`/api/bots/${bot.id}/rules`, {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'block', text: 'Never delete files.', blockedTools: ['Bash(rm:*)'] }),
        });
        const addedRule = await added.json() as { id: string };
        const listed = await requestWithSession(app, `/api/bots/${bot.id}/rules`, sessionToken);
        const invalid = await app.request(`/api/bots/${bot.id}/rules`, {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'allow', text: 'x', blockedTools: ['Bash'] }),
        });
        const unknownBot = await requestWithSession(app, '/api/bots/missing/rules', sessionToken);
        const removed = await app.request(`/api/bots/${bot.id}/rules/${addedRule.id}`, { method: 'DELETE', headers: { cookie } });
        const removedAgain = await app.request(`/api/bots/${bot.id}/rules/${addedRule.id}`, { method: 'DELETE', headers: { cookie } });

        expect(withoutCookie.status)
            .toBe(401);
        expect(added.status)
            .toBe(201);
        expect(await listed.json())
            .toEqual([{ id: addedRule.id, kind: 'block', text: 'Never delete files.', blockedTools: ['Bash(rm:*)'] }]);
        expect(invalid.status)
            .toBe(400);
        expect(unknownBot.status)
            .toBe(404);
        expect(removed.status)
            .toBe(204);
        expect(removedAgain.status)
            .toBe(404);
    });

    it('rejects an api request with a cookie that was never issued', async () => {
        const app = createApp({ version: '1.2.3', access });

        await signIn(app, access);
        const response = await requestWithSession(app, '/api/missing', 'not-a-session');

        expect(response.status)
            .toBe(401);
    });

    it('sets an HttpOnly, Secure, SameSite=Strict session cookie and redirects home for a valid code', async () => {
        const app = createApp({ version: '1.2.3', access });
        const setupCode = await access.issueSetupCode();
        const response = await app.request(`/setup?code=${setupCode}`);
        const setCookieHeader = response.headers.get('set-cookie') ?? '';

        expect(response.status)
            .toBe(302);
        expect(response.headers.get('location'))
            .toBe('/');
        expect(setCookieHeader)
            .toContain('HttpOnly');
        expect(setCookieHeader)
            .toContain('Secure');
        expect(setCookieHeader)
            .toContain('SameSite=Strict');
    });

    it('refuses a setup code that was already used', async () => {
        const app = createApp({ version: '1.2.3', access });
        const setupCode = await access.issueSetupCode();

        await app.request(`/setup?code=${setupCode}`);

        const reusedResponse = await app.request(`/setup?code=${setupCode}`);

        expect(reusedResponse.status)
            .toBe(401);
        expect(readSessionCookie(reusedResponse))
            .toBeUndefined();
    });

    it('refuses a wrong setup code and sets no cookie', async () => {
        const app = createApp({ version: '1.2.3', access });

        await access.issueSetupCode();

        const response = await app.request('/setup?code=wrong-code');

        expect(response.status)
            .toBe(401);
        expect(readSessionCookie(response))
            .toBeUndefined();
    });

    it('refuses a setup request with no code', async () => {
        const app = createApp({ version: '1.2.3', access });
        const response = await app.request('/setup');

        expect(response.status)
            .toBe(401);
    });

    it('ends the old session when a new setup code is issued', async () => {
        const app = createApp({ version: '1.2.3', access });
        const oldSessionToken = await signIn(app, access);

        await access.issueSetupCode();

        const response = await requestWithSession(app, '/api/missing', oldSessionToken);

        expect(response.status)
            .toBe(401);
    });

    it('keeps the health route working when the web app is built', async () => {
        const webRoot = await createWebRoot();
        const app = createApp({ version: '1.2.3', access, webRoot });
        const response = await app.request('/api/health');

        expect(await response.json())
            .toEqual({ status: 'ok', version: '1.2.3' });
    });

    it('serves built assets and falls back to index.html for app routes without a cookie', async () => {
        const webRoot = await createWebRoot();
        const app = createApp({ version: '1.2.3', access, webRoot });
        const assetResponse = await app.request('/assets/app.js');
        const routeResponse = await app.request('/chats/42');

        expect(await assetResponse.text())
            .toBe('console.log(1);');
        expect(await routeResponse.text())
            .toContain('<div id="root"></div>');
    });

    it('does not answer unknown api routes with index.html', async () => {
        const webRoot = await createWebRoot();
        const app = createApp({ version: '1.2.3', access, webRoot });
        const sessionToken = await signIn(app, access);
        const response = await requestWithSession(app, '/api/missing', sessionToken);

        expect(response.status)
            .toBe(404);
    });

    it('does not serve the web app when no build exists', async () => {
        const app = createApp({ version: '1.2.3', access, webRoot: join(tmpdir(), 'cloudbot-missing-web-build') });
        const response = await app.request('/chats/42');

        expect(response.status)
            .toBe(404);
    });
});
