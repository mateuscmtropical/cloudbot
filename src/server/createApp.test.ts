import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SetupAccess } from './access/SetupAccess.ts';
import { FakeAgentRunner } from './agent/FakeAgentRunner.ts';
import { ChatService } from './chat/ChatService.ts';
import { CLEANUP_RETRIES } from './chat/testCleanup.ts';
import { createApp } from './createApp.ts';
import type { PeopleAdmin } from './people/PeopleAdmin.ts';
import { ScreenHolder } from './desktop/ScreenHolder.ts';
import { MAX_RULES_PER_BOT } from './rules/createRuleRoutes.ts';
import { PushSubscriptionStore } from './store/PushSubscriptionStore.ts';
import { RoutineStore } from './store/RoutineStore.ts';
import { RuleStore } from './store/RuleStore.ts';
import { BotStore } from './store/BotStore.ts';
import { MessageStore } from './store/MessageStore.ts';
import type { OpenedDatabase } from './store/openDatabase.ts';
import { openDatabase } from './store/openDatabase.ts';
import { SettingsStore } from './store/SettingsStore.ts';
import { WhatsAppStore } from './store/WhatsAppStore.ts';

const createdDirectories: string[] = [];
// app.request builds its URL on http://localhost, so this is the page's own origin.
const OWN_ORIGIN = 'http://localhost';

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

        await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES })));
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

    it('mounts the people routes behind the session check when people admin is set', async () => {
        const peopleAdmin: PeopleAdmin = {
            list: () => Promise.resolve([]),
            add: () => Promise.reject(new Error('Not used.')),
            deactivate: () => Promise.reject(new Error('Not used.')),
            reactivate: () => Promise.reject(new Error('Not used.')),
            resetPassword: () => Promise.reject(new Error('Not used.')),
            remove: () => Promise.resolve(),
        };
        const app = createApp({ version: '1.2.3', access, peopleAdmin });
        const unauthorized = await app.request('/api/people');
        const sessionToken = await signIn(app, access);
        const authorized = await requestWithSession(app, '/api/people', sessionToken);

        expect(unauthorized.status)
            .toBe(401);
        expect(authorized.status)
            .toBe(200);
        expect(await authorized.json())
            .toEqual([]);
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

    it('lets the owner list and remove a bot\'s routines, and refuses them without the cookie', async () => {
        const chatService = buildChatService(opened);
        const routineStore = new RoutineStore(opened.db);
        const bot = await new BotStore(opened.db)
            .create({ name: 'Ana', title: 'Assistant', description: '' });
        const routine = await routineStore.add(bot.id, { name: 'Inbox', prompt: 'Check.', schedule: { kind: 'daily', hour: 8, minute: 0 } });
        const app = createApp({ version: '1.2.3', access, chatService, routineStore });
        const sessionToken = await signIn(app, access);
        const cookie = `cloudbot_session=${sessionToken}`;
        const withoutCookie = await app.request(`/api/bots/${bot.id}/routines`);
        const listed = await requestWithSession(app, `/api/bots/${bot.id}/routines`, sessionToken);
        const unknownBot = await requestWithSession(app, '/api/bots/missing/routines', sessionToken);
        const removed = await app.request(`/api/bots/${bot.id}/routines/${routine.id}`, { method: 'DELETE', headers: { cookie, origin: OWN_ORIGIN } });
        const removedAgain = await app.request(`/api/bots/${bot.id}/routines/${routine.id}`, { method: 'DELETE', headers: { cookie, origin: OWN_ORIGIN } });

        expect(withoutCookie.status)
            .toBe(401);
        expect(await listed.json())
            .toEqual([{
                id: routine.id,
                name: 'Inbox',
                prompt: 'Check.',
                schedule: { kind: 'daily', hour: 8, minute: 0 },
                isEnabled: true,
                isQuiet: false,
                nextRunAt: routine.nextRunAt,
                lastRunAt: null,
            }]);
        expect(unknownBot.status)
            .toBe(404);
        expect(removed.status)
            .toBe(204);
        expect(removedAgain.status)
            .toBe(404);
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
            headers: { 'cookie': cookie, 'origin': OWN_ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'block', text: 'Never delete files.', blockedTools: ['Bash(rm:*)'] }),
        });
        const addedRule = await added.json() as { id: string };
        const listed = await requestWithSession(app, `/api/bots/${bot.id}/rules`, sessionToken);
        const invalid = await app.request(`/api/bots/${bot.id}/rules`, {
            method: 'POST',
            headers: { 'cookie': cookie, 'origin': OWN_ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'allow', text: 'x', blockedTools: ['Bash'] }),
        });
        const unknownBot = await requestWithSession(app, '/api/bots/missing/rules', sessionToken);
        const removed = await app.request(`/api/bots/${bot.id}/rules/${addedRule.id}`, { method: 'DELETE', headers: { cookie, origin: OWN_ORIGIN } });
        const removedAgain = await app.request(`/api/bots/${bot.id}/rules/${addedRule.id}`, { method: 'DELETE', headers: { cookie, origin: OWN_ORIGIN } });

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

    it('refuses a rule past the limit for one bot', async () => {
        const chatService = buildChatService(opened);
        const ruleStore = new RuleStore(opened.db);
        const bot = await new BotStore(opened.db)
            .create({ name: 'Ana', title: 'Assistant', description: '' });
        const app = createApp({ version: '1.2.3', access, chatService, ruleStore });
        const sessionToken = await signIn(app, access);
        const ruleIndexes = Array.from({ length: MAX_RULES_PER_BOT }, (_unused, index) => index);

        await Promise.all(ruleIndexes.map(index => ruleStore.add(bot.id, { kind: 'allow', text: `Rule ${String(index)}.`, blockedTools: [] })));

        const response = await app.request(`/api/bots/${bot.id}/rules`, {
            method: 'POST',
            headers: { 'cookie': `cloudbot_session=${sessionToken}`, 'origin': OWN_ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'allow', text: 'One more.' }),
        });

        expect(response.status)
            .toBe(400);
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

    it('lets the browser keep hashed assets for good, and checks the page again on every visit', async () => {
        const webRoot = await createWebRoot();
        const app = createApp({ version: '1.2.3', access, webRoot });
        const assetResponse = await app.request('/assets/app.js');
        const pageResponse = await app.request('/');
        const routeResponse = await app.request('/chats/42');

        expect(assetResponse.headers.get('cache-control'))
            .toBe('public, max-age=31536000, immutable');
        expect(pageResponse.headers.get('cache-control'))
            .toBe('no-cache');
        expect(routeResponse.headers.get('cache-control'))
            .toBe('no-cache');
    });

    it('serves the manifest and the service worker without a cookie, and checks them again on every visit', async () => {
        const webRoot = await createWebRoot();

        await writeFile(join(webRoot, 'manifest.webmanifest'), '{"name":"CloudBot"}');
        await writeFile(join(webRoot, 'sw.js'), 'self.addEventListener("push", () => {});');

        const app = createApp({ version: '1.2.3', access, webRoot });
        const manifestResponse = await app.request('/manifest.webmanifest');
        const workerResponse = await app.request('/sw.js');

        expect(manifestResponse.headers.get('content-type'))
            .toContain('application/manifest+json');
        expect(await manifestResponse.text())
            .toBe('{"name":"CloudBot"}');
        expect(workerResponse.headers.get('content-type'))
            .toContain('javascript');
        expect(workerResponse.headers.get('cache-control'))
            .toBe('no-cache');
    });

    // The headers that the page's own fetch sends. The origin check refuses a state-changing request without them.
    const OWN_PAGE_HEADERS = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

    it('gives the push key and saves a subscription with a cookie, and refuses both without one', async () => {
        const store = new PushSubscriptionStore(opened.db);
        const app = createApp({ version: '1.2.3', access, push: { store, publicKey: 'public-key-text' } });
        const sessionToken = await signIn(app, access);
        const subscription = JSON.stringify({ endpoint: 'http://169.254.169.254/latest', keys: { p256dh: 'x', auth: 'y' } });
        const withoutCookieKey = await app.request('/api/push/key');
        const withoutCookieSave = await app.request('/api/push/subscriptions', { method: 'POST', body: subscription, headers: OWN_PAGE_HEADERS });
        const keyResponse = await requestWithSession(app, '/api/push/key', sessionToken);
        const refusedResponse = await app.request('/api/push/subscriptions', { method: 'POST', body: subscription, headers: { ...OWN_PAGE_HEADERS, cookie: `cloudbot_session=${sessionToken}` } });

        expect(withoutCookieKey.status)
            .toBe(401);
        expect(withoutCookieSave.status)
            .toBe(401);
        expect(await keyResponse.json())
            .toEqual({ publicKey: 'public-key-text' });
        // An address that is not a push service is refused even for the owner.
        expect(refusedResponse.status)
            .toBe(400);
    });

    it('removes a subscription with a cookie and refuses the removal without one', async () => {
        const store = new PushSubscriptionStore(opened.db);

        await store.save({ endpoint: 'https://fcm.googleapis.com/fcm/send/mine', p256dh: 'key', auth: 'auth' });

        const app = createApp({ version: '1.2.3', access, push: { store, publicKey: 'public-key-text' } });
        const sessionToken = await signIn(app, access);
        const body = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/mine' });
        const withoutCookie = await app.request('/api/push/subscriptions', { method: 'DELETE', body, headers: OWN_PAGE_HEADERS });

        expect(withoutCookie.status)
            .toBe(401);
        await expect(store.list())
            .resolves.toHaveLength(1);

        const withCookie = await app.request('/api/push/subscriptions', { method: 'DELETE', body, headers: { ...OWN_PAGE_HEADERS, cookie: `cloudbot_session=${sessionToken}` } });

        expect(withCookie.status)
            .toBe(204);
        await expect(store.list())
            .resolves.toEqual([]);
    });

    it('refuses to change push subscriptions from another site or without a JSON body type', async () => {
        const store = new PushSubscriptionStore(opened.db);

        await store.save({ endpoint: 'https://fcm.googleapis.com/fcm/send/mine', p256dh: 'key', auth: 'auth' });

        const app = createApp({ version: '1.2.3', access, push: { store, publicKey: 'public-key-text' } });
        const sessionToken = await signIn(app, access);
        const cookie = `cloudbot_session=${sessionToken}`;
        const body = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/mine' });
        const crossSite = await app.request('/api/push/subscriptions', { method: 'DELETE', body, headers: { 'cookie': cookie, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } });
        const textBody = await app.request('/api/push/subscriptions', { method: 'DELETE', body, headers: { 'cookie': cookie, 'content-type': 'text/plain', 'content-length': String(body.length), 'sec-fetch-site': 'same-origin' } });

        expect(crossSite.status)
            .toBe(403);
        expect(textBody.status)
            .toBe(415);
        await expect(store.list())
            .resolves.toHaveLength(1);
    });

    it('answers a missing asset with 404 and no-store, not with index.html', async () => {
        const webRoot = await createWebRoot();
        const app = createApp({ version: '1.2.3', access, webRoot });
        const response = await app.request('/assets/missing.js');

        expect(response.status)
            .toBe(404);
        expect(response.headers.get('cache-control'))
            .toBe('no-store');
        expect(await response.text())
            .not.toContain('<div id="root"></div>');
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

    it('lets the owner take the screen and give it back', async () => {
        const screen = new ScreenHolder();
        const app = createApp({ version: '1.2.3', access, screen });
        const sessionToken = await signIn(app, access);
        const post = (path: string): Response | Promise<Response> => app.request(path, { method: 'POST', headers: { cookie: `cloudbot_session=${sessionToken}`, origin: OWN_ORIGIN } });

        expect(await (await requestWithSession(app, '/api/desktop/screen', sessionToken)).json())
            .toEqual({ holder: 'bot' });
        expect(await (await post('/api/desktop/screen/take')).json())
            .toEqual({ holder: 'person' });
        expect(screen.holder)
            .toBe('person');
        expect(await (await post('/api/desktop/screen/release')).json())
            .toEqual({ holder: 'bot' });
        expect(screen.holder)
            .toBe('bot');
    });

    it('rejects the screen routes without the cookie', async () => {
        const screen = new ScreenHolder();
        const app = createApp({ version: '1.2.3', access, screen });
        const response = await app.request('/api/desktop/screen/release', { method: 'POST', headers: { origin: OWN_ORIGIN } });

        expect(response.status)
            .toBe(401);
    });

    it('refuses a change from another page or with a form body, even with a valid session', async () => {
        const chatService = buildChatService(opened);
        const bot = await new BotStore(opened.db)
            .create({ name: 'Ana', title: 'Assistant', description: '' });
        const app = createApp({ version: '1.2.3', access, chatService });
        const sessionToken = await signIn(app, access);
        const cookie = `cloudbot_session=${sessionToken}`;
        const messagesPath = `/api/bots/${bot.id}/messages`;
        const otherPort = await app.request('/api/bots', { method: 'POST', headers: { cookie, origin: 'http://localhost:5173' } });
        const noOrigin = await app.request('/api/bots', { method: 'POST', headers: { cookie } });
        const formBody = await app.request(messagesPath, { method: 'POST', headers: { cookie, 'origin': OWN_ORIGIN, 'content-type': 'text/plain', 'content-length': '13' }, body: JSON.stringify({ text: 'hi' }) });
        const created = await app.request('/api/bots', { method: 'POST', headers: { cookie, origin: OWN_ORIGIN } });

        expect([otherPort.status, noOrigin.status, formBody.status, created.status])
            .toEqual([403, 403, 415, 201]);
    });

    it('lets the public address change state when CLOUDBOT_PUBLIC_URL names it', async () => {
        const chatService = buildChatService(opened);
        const app = createApp({ version: '1.2.3', access, chatService, publicUrl: 'https://bot.example.com' });
        const sessionToken = await signIn(app, access);
        const cookie = `cloudbot_session=${sessionToken}`;
        const response = await app.request('/api/bots', { method: 'POST', headers: { cookie, origin: 'https://bot.example.com' } });

        expect(response.status)
            .toBe(201);
    });

    it('serves the WhatsApp webhook without a session and refuses a call that no connection signed', async () => {
        const chatService = buildChatService(opened);
        const secrets = { read: () => undefined };
        const app = createApp({ version: '1.2.3', access, chatService, whatsappStore: new WhatsAppStore(opened.db), whatsappSecrets: secrets });
        const post = await app.request('/whatsapp', { method: 'POST', body: '{}' });
        const handshake = await app.request('/whatsapp?hub.mode=subscribe&hub.verify_token=token&hub.challenge=challenge');

        expect([post.status, handshake.status])
            .toEqual([401, 403]);
    });

    it('sends the security headers with the page and with the API', async () => {
        const webRoot = await createWebRoot();
        const app = createApp({ version: '1.2.3', access, webRoot });
        const page = await app.request('/');
        const health = await app.request('/api/health');

        expect(page.headers.get('content-security-policy'))
            .toContain('frame-ancestors \'none\'');
        expect(page.headers.get('x-frame-options'))
            .toBe('DENY');
        expect(health.headers.get('x-content-type-options'))
            .toBe('nosniff');
    });
});
