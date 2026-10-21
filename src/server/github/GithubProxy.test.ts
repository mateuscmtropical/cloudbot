import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { canMakeLoopbackCertificate } from './canMakeLoopbackCertificate.ts';
import { GithubProxy } from './GithubProxy.ts';
import { createLoopbackCertificate, removeLoopbackCertificate } from './loopbackCertificate.ts';
import type { LoopbackCertificate } from './loopbackCertificate.ts';

interface FakeCall {
    url: string;
    method: string;
    authorization: string | null;
}

interface ProxyState {
    token: string | undefined;
    tokenError: boolean;
    approvals: string[];
    approvalAnswer: boolean;
    // When set, the owner's answer is this promise, so a test can keep a card open.
    approvalGate: Promise<boolean> | undefined;
    upstreamCalls: FakeCall[];
    upstreamStatus: number;
}

interface ProxyReply {
    status: number;
    text: string;
}

const BOT_ID = 'bot-1';
const TOKEN = 'ghp_PROXY_TEST_TOKEN';

function pktLine(payload: string): string {
    const lengthHex = (payload.length + 4).toString(16)
        .padStart(4, '0');

    return `${lengthHex}${payload}`;
}

// One ref command that creates a branch, then the flush packet and a stand-in pack.
const PUSH_COMMAND = `${'0'.repeat(40)} ${'b'.repeat(40)} refs/heads/cloudbot-test\0report-status\n`;
const PUSH_BODY = `${pktLine(PUSH_COMMAND)}0000PACK-DATA`;

// The tests need openssl to make the certificate. Without it they are skipped, as the server is then off too.
const canRunProxy = canMakeLoopbackCertificate();

function portFromHost(host: string): number {
    const hostParts = host.split(':');
    const portText = hostParts[1] ?? '';

    return Number(portText);
}

describe.skipIf(!canRunProxy)('GithubProxy', () => {
    const state: ProxyState = {
        token: TOKEN,
        tokenError: false,
        approvals: [],
        approvalAnswer: true,
        approvalGate: undefined,
        upstreamCalls: [],
        upstreamStatus: 200,
    };
    let certificate: LoopbackCertificate;
    let proxy: GithubProxy;
    let environment: Record<string, string>;
    let port: number;

    function readToken(): string | undefined {
        if (state.tokenError) {
            throw new Error('The GitHub token is saved for another site.');
        }

        return state.token;
    }

    function approve(_botId: string, summary: string): Promise<boolean> {
        state.approvals.push(summary);

        return state.approvalGate ?? Promise.resolve(state.approvalAnswer);
    }

    function fetchFunction(url: URL, init: RequestInit): Promise<Response> {
        const sentHeaders = new Headers(init.headers);

        state.upstreamCalls.push({ url: url.href, method: init.method ?? '', authorization: sentHeaders.get('authorization') });

        if (state.upstreamStatus === 302) {
            return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }));
        }

        return Promise.resolve(new Response('{"ok":true}', { status: state.upstreamStatus, headers: { 'content-type': 'application/json' } }));
    }

    function send(method: string, path: string, headers: Record<string, string>, body?: string): Promise<ProxyReply> {
        return new Promise((resolve, reject) => {
            const clientRequest = httpsRequest({ host: '127.0.0.1', port, path, method, headers, ca: certificate.cert }, (response: IncomingMessage) => {
                const chunks: Buffer[] = [];

                response.on('data', (chunk: Buffer) => {
                    chunks.push(chunk);
                });
                response.on('end', () => {
                    const text = Buffer.concat(chunks)
                        .toString('utf8');

                    resolve({ status: response.statusCode ?? 0, text });
                });
            });

            clientRequest.on('error', reject);
            clientRequest.end(body);
        });
    }

    beforeAll(async () => {
        certificate = await createLoopbackCertificate();
        proxy = new GithubProxy({
            readToken,
            approve,
            key: certificate.key,
            cert: certificate.cert,
            caFile: certificate.caFile,
            bundleFile: certificate.bundleFile,
            fetchFunction,
        });
        environment = await proxy.environmentFor(BOT_ID);
        port = portFromHost(environment.GH_HOST ?? '');
    });

    afterAll(async () => {
        await proxy.close();
        await removeLoopbackCertificate(certificate);
    });

    beforeEach(() => {
        state.token = TOKEN;
        state.tokenError = false;
        state.approvals = [];
        state.approvalAnswer = true;
        state.approvalGate = undefined;
        state.upstreamCalls = [];
        state.upstreamStatus = 200;
    });

    it('replaces the agent authorization header with the saved token, and keeps the token out of the reply', async () => {
        const logSpies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
        const reply = await send('GET', '/api/v3/user', { authorization: 'token agent-value' });

        expect(state.upstreamCalls)
            .toEqual([{ url: 'https://api.github.com/user', method: 'GET', authorization: `Bearer ${TOKEN}` }]);
        expect(reply.status)
            .toBe(200);
        expect(reply.text).not.toContain(TOKEN);
        logSpies.forEach((spy) => {
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });
    });

    it('sends git requests to github.com with basic auth', async () => {
        await send('GET', '/owner/repo.git/info/refs?service=git-upload-pack', {});
        const expectedAuthorization = `Basic ${Buffer.from(`x-access-token:${TOKEN}`)
            .toString('base64')}`;

        expect(state.upstreamCalls)
            .toEqual([
                { url: 'https://github.com/owner/repo.git/info/refs?service=git-upload-pack', method: 'GET', authorization: expectedAuthorization },
            ]);
    });

    it('refuses any other address without sending anything', async () => {
        const reply = await send('GET', '/evil.example/x', {});

        expect(reply.status)
            .toBe(404);
        expect(state.upstreamCalls)
            .toEqual([]);
    });

    it('lets reads through without asking the owner', async () => {
        await send('GET', '/api/v3/repos/owner/repo', {});
        await send('POST', '/owner/repo.git/git-upload-pack', {}, '0000');
        await send('POST', '/api/graphql', {}, JSON.stringify({ query: 'query { viewer { login } }' }));

        expect(state.approvals)
            .toEqual([]);
        expect(state.upstreamCalls)
            .toHaveLength(3);
    });

    it('asks the owner before a push, then sends it', async () => {
        const reply = await send('POST', '/owner/repo.git/git-receive-pack', {}, PUSH_BODY);

        expect(state.approvals)
            .toEqual(['Push commits to owner/repo on GitHub.']);
        expect(reply.status)
            .toBe(200);
        expect(state.upstreamCalls.map(call => call.url))
            .toEqual(['https://github.com/owner/repo.git/git-receive-pack']);
    });

    it('refuses a push the owner denies, with a clear body the bot can read', async () => {
        state.approvalAnswer = false;

        const reply = await send('POST', '/owner/repo.git/git-receive-pack', {}, PUSH_BODY);

        expect(reply.status)
            .toBe(403);
        expect(reply.text)
            .toContain('did not approve');
        expect(reply.text).not.toContain(TOKEN);
        expect(state.upstreamCalls)
            .toEqual([]);
    });

    it('refuses a push when no token is saved, before asking the owner', async () => {
        state.token = undefined;

        const reply = await send('GET', '/owner/repo.git/info/refs?service=git-receive-pack', {});

        expect(reply.status)
            .toBe(401);
        expect(reply.text)
            .toContain('GITHUB_TOKEN');
        expect(state.approvals)
            .toEqual([]);
        expect(state.upstreamCalls)
            .toEqual([]);
    });

    it('asks the owner before a REST write and shows the pull request title', async () => {
        state.approvalAnswer = false;

        const body = JSON.stringify({ title: 'Add the proxy' });
        const reply = await send('POST', '/api/v3/repos/owner/repo/pulls', { 'content-type': 'application/json' }, body);

        expect(state.approvals)
            .toEqual(['Open a pull request in owner/repo titled "Add the proxy".']);
        expect(reply.status)
            .toBe(403);
        expect(state.upstreamCalls)
            .toEqual([]);
    });

    it('does not send a request when the saved token is for another site', async () => {
        state.tokenError = true;

        const reply = await send('GET', '/api/v3/user', {});

        expect(reply.status)
            .toBe(502);
        expect(reply.text)
            .toContain('another site');
        expect(state.upstreamCalls)
            .toEqual([]);
    });

    it('does not follow a redirect', async () => {
        state.upstreamStatus = 302;

        const reply = await send('GET', '/api/v3/user', {});

        expect(reply.status)
            .toBe(502);
        expect(reply.text)
            .toContain('redirect');
    });

    it('refuses a push whose ref commands cannot be read, before asking the owner', async () => {
        const reply = await send('POST', '/owner/repo.git/git-receive-pack', {}, 'not a pkt-line body');

        expect(reply.status)
            .toBe(403);
        expect(state.approvals)
            .toEqual([]);
    });

    it('refuses a second write while the owner has one card open, without asking again', async () => {
        let releaseFirst: (answer: boolean) => void = () => undefined;
        const firstDecision = new Promise<boolean>((resolve) => {
            releaseFirst = resolve;
        });
        const jsonHeaders = { 'content-type': 'application/json' };

        state.approvalGate = firstDecision;
        const firstWrite = send('POST', '/api/v3/repos/o/r/issues/1/comments', jsonHeaders, '{"body":"one"}');

        await vi.waitFor(() => {
            expect(state.approvals)
                .toHaveLength(1);
        });

        const secondReply = await send('POST', '/api/v3/repos/o/r/issues/2/comments', jsonHeaders, '{"body":"two"}');

        expect(secondReply.status)
            .toBe(429);
        expect(secondReply.text)
            .toContain('Another GitHub change is waiting for the owner.');
        expect(state.approvals)
            .toHaveLength(1);

        releaseFirst(true);
        const firstReply = await firstWrite;

        expect(firstReply.status)
            .toBe(200);
    });

    it('gives each bot its own port', async () => {
        const otherEnvironment = await proxy.environmentFor('bot-2');
        const repeatedEnvironment = await proxy.environmentFor(BOT_ID);

        expect(otherEnvironment.GH_HOST).not.toBe(environment.GH_HOST);
        expect(repeatedEnvironment.GH_HOST)
            .toBe(environment.GH_HOST);
    });
});
