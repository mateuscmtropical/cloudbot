import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BotSecret } from '../secrets/BotSecrets.ts';
import { ConnectedAppStore } from '../store/ConnectedAppStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { AppProxy } from './AppProxy.ts';
import { ConnectedApps } from './ConnectedApps.ts';
import type { AllowedPrivateHost } from './appAddress.ts';
import type { ConnectInput } from './ConnectedApps.ts';
import type { FetchFunction } from './probeAppServer.ts';

const BOT_ID = 'bot-1';
const SERVER_URL = 'https://mcp.example.com/mcp';
const PUBLIC_ADDRESS = '93.184.216.34';

// A fake server. Without a bearer token it refuses with 401, as a server that needs one would.
function fakeServer(): { fetch: FetchFunction; authSeen: string[] } {
    const authSeen: string[] = [];
    const respond = (init: RequestInit): Response => {
        const headers = init.headers as Record<string, string>;
        const rawBody = typeof init.body === 'string' ? init.body : '{}';
        const body = JSON.parse(rawBody) as Record<string, unknown>;

        authSeen.push(headers['authorization'] ?? '');

        if (headers['authorization'] === undefined) {
            return new Response('no', { status: 401 });
        }

        if (body['method'] === 'initialize') {
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
        }

        if (body['method'] === 'tools/list') {
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }

        return new Response(null, { status: 202 });
    };

    const fetchFunction: FetchFunction = (_url, init) => Promise.resolve(respond(init));

    return { fetch: fetchFunction, authSeen };
}

function memorySecrets(initial: Record<string, BotSecret>): { read: (botId: string, name: string) => BotSecret | undefined; remove: (botId: string, name: string) => void; has: (name: string) => boolean; put: (name: string, secret: BotSecret) => void } {
    const secrets = new Map<string, BotSecret>(Object.entries(initial));

    return {
        put: (name, secret) => {
            secrets.set(`${BOT_ID}:${name}`, secret);
        },
        read: (botId, name) => secrets.get(`${botId}:${name}`),
        remove: (botId, name) => {
            secrets.delete(`${botId}:${name}`);
        },
        has: name => secrets.has(`${BOT_ID}:${name}`),
    };
}

function publicAddressDeps(): (allowedHosts: AllowedPrivateHost[]) => { resolve: () => Promise<string[]>; localAddresses: string[]; allowedHosts: AllowedPrivateHost[] } {
    return allowedHosts => ({ resolve: () => Promise.resolve([PUBLIC_ADDRESS]), localAddresses: [], allowedHosts });
}

function connectInput(overrides: Partial<ConnectInput> = {}): ConnectInput {
    return { name: 'linear', url: SERVER_URL, tokenSecret: undefined, ...overrides };
}

describe('ConnectedApps', () => {
    let opened: OpenedDatabase;
    let proxy: AppProxy;
    let store: ConnectedAppStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        proxy = new AppProxy({ checkUpstream: () => Promise.resolve(['127.0.0.1']) });
        await proxy.start();
        store = new ConnectedAppStore(opened.db, { now: () => 1000 });
    });

    afterEach(async () => {
        await proxy.close();
        opened.close();
    });

    function appsWith(secrets: ReturnType<typeof memorySecrets>, fetchFunction: FetchFunction): ConnectedApps {
        return new ConnectedApps({
            store,
            secrets,
            proxy,
            allowedHosts: () => Promise.resolve([]),
            addressDeps: publicAddressDeps(),
            fetchFunction,
        });
    }

    it('connects a server with the token of the bot, and gives the bot the proxy address only', async () => {
        const server = fakeServer();
        const secrets = memorySecrets({ [`${BOT_ID}:LINEAR_TOKEN`]: { site: 'https://mcp.example.com', value: 'tok-123' } });
        const apps = appsWith(secrets, server.fetch);

        const outcome = await apps.connect(BOT_ID, connectInput({ tokenSecret: 'LINEAR_TOKEN' }));

        expect(outcome)
            .toEqual({ outcome: 'connected', name: 'linear', toolCount: 3 });
        expect(server.authSeen.at(-1))
            .toBe('Bearer tok-123');

        const configs = await apps.serverConfigs();

        expect(configs['linear']?.type)
            .toBe('http');
        expect(JSON.stringify(configs))
            .not.toContain('mcp.example.com');
        expect(JSON.stringify(configs))
            .not.toContain('tok-123');
        expect(JSON.stringify(await store.list()))
            .not.toContain('tok-123');
    });

    it('asks for a token when the server refuses without one, and connects no route', async () => {
        const apps = appsWith(memorySecrets({}), fakeServer().fetch);

        const outcome = await apps.connect(BOT_ID, connectInput());

        expect(outcome)
            .toEqual({ outcome: 'needs_token', name: 'linear', origin: 'https://mcp.example.com' });
        expect(await apps.serverConfigs())
            .toEqual({});
    });

    it('refuses a token that is not saved yet, and a token for another site or for plain http', async () => {
        const secrets = memorySecrets({ [`${BOT_ID}:OTHER_TOKEN`]: { site: 'https://elsewhere.test', value: 'tok' } });
        const apps = appsWith(secrets, fakeServer().fetch);

        expect(await apps.connect(BOT_ID, connectInput({ tokenSecret: 'MISSING' })))
            .toEqual({ outcome: 'refused', problem: 'That secret is not saved yet. Ask the owner to fill in the secure form first.' });
        expect(await apps.connect(BOT_ID, connectInput({ tokenSecret: 'OTHER_TOKEN' })))
            .toEqual({ outcome: 'refused', problem: 'The saved secret is for another site, so it is not sent here.' });
        expect(await apps.connect(BOT_ID, connectInput({ url: 'http://mcp.example.com/mcp', tokenSecret: 'OTHER_TOKEN' })))
            .toEqual({ outcome: 'refused', problem: 'A token is sent only to an https address.' });
    });

    it('refuses a reserved name and a name with capital letters', async () => {
        const apps = appsWith(memorySecrets({}), fakeServer().fetch);

        expect((await apps.connect(BOT_ID, connectInput({ name: 'cloudbot' }))).outcome)
            .toBe('refused');
        expect((await apps.connect(BOT_ID, connectInput({ name: 'Linear' }))).outcome)
            .toBe('refused');
    });

    it('lists the servers with their status and tool count, and removes one with its token', async () => {
        const secrets = memorySecrets({ [`${BOT_ID}:LINEAR_TOKEN`]: { site: 'https://mcp.example.com', value: 'tok-123' } });
        const apps = appsWith(secrets, fakeServer().fetch);

        await apps.connect(BOT_ID, connectInput({ tokenSecret: 'LINEAR_TOKEN' }));

        const [listed] = await apps.list();

        expect(listed)
            .toMatchObject({ name: 'linear', status: 'connected', toolCount: 3 });
        expect(secrets.has('LINEAR_TOKEN'))
            .toBe(true);

        expect(await apps.remove(listed?.id ?? ''))
            .toBe(true);
        expect(secrets.has('LINEAR_TOKEN'))
            .toBe(false);
        expect(await apps.list())
            .toEqual([]);
        expect(await apps.serverConfigs())
            .toEqual({});
    });

    it('refuses an address that is private for the owner', async () => {
        const apps = new ConnectedApps({
            store,
            secrets: memorySecrets({}),
            proxy,
            allowedHosts: () => Promise.resolve([]),
            addressDeps: () => ({ resolve: () => Promise.resolve(['192.168.1.20']), localAddresses: [], allowedHosts: [] }),
            fetchFunction: fakeServer().fetch,
        });

        const outcome = await apps.connect(BOT_ID, connectInput({ url: 'https://intranet.test/mcp' }));

        expect(outcome.outcome)
            .toBe('refused');
    });

    it('stops sending the token when the saved secret is overwritten for another site', async () => {
        const secrets = memorySecrets({ [`${BOT_ID}:LINEAR_TOKEN`]: { site: 'https://mcp.example.com', value: 'tok-123' } });
        const apps = appsWith(secrets, fakeServer().fetch);

        await apps.connect(BOT_ID, connectInput({ tokenSecret: 'LINEAR_TOKEN' }));
        secrets.put('LINEAR_TOKEN', { site: 'https://elsewhere.test', value: 'tok-other' });

        const configs = await apps.serverConfigs();
        const address = configs['linear'] === undefined ? '' : (configs['linear'] as { url: string }).url;
        const response = await fetch(address, { method: 'POST', body: '{}' });

        expect(response.status)
            .toBe(502);
        expect(await response.text())
            .not.toContain('tok-other');
    });

    it('keeps the old connection when a reconnect does not connect, and says so', async () => {
        const secrets = memorySecrets({ [`${BOT_ID}:LINEAR_TOKEN`]: { site: 'https://mcp.example.com', value: 'tok-123' } });
        const apps = appsWith(secrets, fakeServer().fetch);

        await apps.connect(BOT_ID, connectInput({ tokenSecret: 'LINEAR_TOKEN' }));
        const down = appsWith(secrets, () => Promise.reject(new Error('down')));
        const outcome = await down.connect(BOT_ID, connectInput({ url: 'https://mcp.example.com/other', tokenSecret: 'LINEAR_TOKEN' }));

        expect(outcome)
            .toMatchObject({ outcome: 'refused' });
        expect(outcome)
            .toMatchObject({ problem: expect.stringContaining('its old connection stays') as unknown });
        expect(await apps.list())
            .toMatchObject([{ name: 'linear', status: 'connected', url: SERVER_URL }]);
        expect(Object.keys(await apps.serverConfigs()))
            .toEqual(['linear']);
    });

    it('deletes the replaced token of a reconnect, when no other server uses it', async () => {
        const secrets = memorySecrets({
            [`${BOT_ID}:OLD_TOKEN`]: { site: 'https://mcp.example.com', value: 'tok-old' },
            [`${BOT_ID}:NEW_TOKEN`]: { site: 'https://mcp.example.com', value: 'tok-new' },
        });
        const apps = appsWith(secrets, fakeServer().fetch);

        await apps.connect(BOT_ID, connectInput({ tokenSecret: 'OLD_TOKEN' }));
        await apps.connect(BOT_ID, connectInput({ tokenSecret: 'NEW_TOKEN' }));

        expect(secrets.has('OLD_TOKEN'))
            .toBe(false);
        expect(secrets.has('NEW_TOKEN'))
            .toBe(true);
    });

    it('keeps a shared token until the last server that uses it is removed', async () => {
        const secrets = memorySecrets({ [`${BOT_ID}:SHARED_TOKEN`]: { site: 'https://mcp.example.com', value: 'tok-123' } });
        const apps = appsWith(secrets, fakeServer().fetch);

        await apps.connect(BOT_ID, connectInput({ tokenSecret: 'SHARED_TOKEN' }));
        await apps.connect(BOT_ID, connectInput({ name: 'docs', url: 'https://mcp.example.com/docs', tokenSecret: 'SHARED_TOKEN' }));

        const listed = await apps.list();
        const linearId = listed.find(app => app.name === 'linear')?.id ?? '';
        const docsId = listed.find(app => app.name === 'docs')?.id ?? '';

        await apps.remove(linearId);
        expect(secrets.has('SHARED_TOKEN'))
            .toBe(true);

        await apps.remove(docsId);
        expect(secrets.has('SHARED_TOKEN'))
            .toBe(false);
    });
});
