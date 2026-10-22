import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { readPublicHost, requireSameOrigin } from './requireSameOrigin.ts';
import type { SameOriginOptions } from './requireSameOrigin.ts';

// app.request builds its URL on http://localhost, so that is the page's own origin.
const OWN_ORIGIN = 'http://localhost';
const JSON_BODY = '{"text":"hi"}';
// A node server always has the length header of a request with a body, and a test request does not add it.
const JSON_LENGTH = String(JSON_BODY.length);

function createGuardedApp(options: SameOriginOptions = {}): Hono {
    const app = new Hono();

    app.use('/api/*', requireSameOrigin(options));
    app.all('/api/*', context => context.json({ ok: true }));

    return app;
}

function sendJson(app: Hono, method: string, headers: Record<string, string>): Response | Promise<Response> {
    return app.request('/api/thing', { method, headers: { 'content-type': 'application/json', 'content-length': JSON_LENGTH, ...headers }, body: JSON_BODY });
}

describe('requireSameOrigin', () => {
    it('lets a read through without an Origin header', async () => {
        const app = createGuardedApp();
        const response = await app.request('/api/thing');

        expect(response.status)
            .toBe(200);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('lets a %s from the page itself through', async (method) => {
        const app = createGuardedApp();
        const response = await sendJson(app, method, { origin: OWN_ORIGIN });

        expect(response.status)
            .toBe(200);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses a %s from a page on another local port', async (method) => {
        const app = createGuardedApp();
        const response = await sendJson(app, method, { origin: 'http://localhost:5173' });

        expect(response.status)
            .toBe(403);
    });

    it('refuses a request from another site and from an opaque origin', async () => {
        const app = createGuardedApp();
        const otherSite = await sendJson(app, 'POST', { origin: 'https://evil.example.com' });
        const opaque = await sendJson(app, 'POST', { origin: 'null' });
        const unreadable = await sendJson(app, 'POST', { origin: 'not a url' });

        expect([otherSite.status, opaque.status, unreadable.status])
            .toEqual([403, 403, 403]);
    });

    it('refuses a change with no Origin unless the browser says it is a same-origin fetch', async () => {
        const app = createGuardedApp();
        const bare = await sendJson(app, 'POST', {});
        const sameOrigin = await sendJson(app, 'POST', { 'sec-fetch-site': 'same-origin' });
        const sameSite = await sendJson(app, 'POST', { 'sec-fetch-site': 'same-site' });

        expect([bare.status, sameOrigin.status, sameSite.status])
            .toEqual([403, 200, 403]);
    });

    it('refuses a matching Origin when the browser marks the fetch as cross site', async () => {
        const app = createGuardedApp();
        const response = await sendJson(app, 'POST', { 'origin': OWN_ORIGIN, 'sec-fetch-site': 'cross-site' });

        expect(response.status)
            .toBe(403);
    });

    it('accepts the host of the public address only when one is set', async () => {
        const publicHost = readPublicHost('https://bot.example.com/');
        const withPublic = createGuardedApp({ publicHost });
        const withoutPublic = createGuardedApp();
        const accepted = await sendJson(withPublic, 'POST', { origin: 'https://bot.example.com' });
        const refused = await sendJson(withoutPublic, 'POST', { origin: 'https://bot.example.com' });

        expect([accepted.status, refused.status])
            .toEqual([200, 403]);
    });

    it('says which refusal it is in the body', async () => {
        const app = createGuardedApp();
        const wrongOrigin = await sendJson(app, 'POST', { origin: 'https://evil.example.com' });
        const wrongType = await app.request('/api/thing', { method: 'POST', headers: { 'origin': OWN_ORIGIN, 'content-type': 'text/plain', 'content-length': JSON_LENGTH }, body: JSON_BODY });

        expect(await wrongOrigin.json())
            .toEqual({ error: 'This request did not come from the CloudBot page.' });
        expect(await wrongType.json())
            .toEqual({ error: 'Send the body as application/json.' });
    });

    it('requires application/json when there is a body, and ignores a charset', async () => {
        const app = createGuardedApp();
        const post = (contentType: string): Response | Promise<Response> => app.request('/api/thing', {
            method: 'POST',
            headers: { 'origin': OWN_ORIGIN, 'content-type': contentType, 'content-length': JSON_LENGTH },
            body: JSON_BODY,
        });
        const plain = await post('text/plain');
        const form = await post('application/x-www-form-urlencoded');
        const multipart = await post('multipart/form-data; boundary=x');
        const json = await post('application/json');
        const withCharset = await post('Application/JSON; charset=utf-8');

        expect([plain.status, form.status, multipart.status, json.status, withCharset.status])
            .toEqual([415, 415, 415, 200, 200]);
    });

    it('refuses a body with no content type', async () => {
        const app = createGuardedApp();
        // Bytes carry no default content type, unlike a string body.
        const encoder = new TextEncoder();
        const bytes = encoder.encode(JSON_BODY);
        const response = await app.request('/api/thing', { method: 'POST', headers: { 'origin': OWN_ORIGIN, 'content-length': JSON_LENGTH }, body: bytes });

        expect(response.status)
            .toBe(415);
    });

    it('needs no content type when there is no body', async () => {
        const app = createGuardedApp();
        const post = await app.request('/api/thing', { method: 'POST', headers: { origin: OWN_ORIGIN } });
        const remove = await app.request('/api/thing', { method: 'DELETE', headers: { origin: OWN_ORIGIN } });

        expect([post.status, remove.status])
            .toEqual([200, 200]);
    });

    it('takes multipart only on the upload route', async () => {
        const app = createGuardedApp();
        const upload = (path: string, contentType: string): Response | Promise<Response> => app.request(path, {
            method: 'POST',
            headers: { 'origin': OWN_ORIGIN, 'content-type': contentType, 'content-length': '10' },
            body: 'file bytes',
        });
        const multipartUpload = await upload('/api/bots/abc/attachments', 'multipart/form-data; boundary=x');
        const jsonUpload = await upload('/api/bots/abc/attachments', 'application/json');
        const multipartElsewhere = await upload('/api/bots/abc/messages', 'multipart/form-data; boundary=x');

        expect([multipartUpload.status, jsonUpload.status, multipartElsewhere.status])
            .toEqual([200, 415, 415]);
    });

    it('checks the origin before the content type', async () => {
        const app = createGuardedApp();
        const response = await app.request('/api/thing', {
            method: 'POST',
            headers: { 'origin': 'https://evil.example.com', 'content-type': 'text/plain', 'content-length': JSON_LENGTH },
            body: JSON_BODY,
        });

        expect(response.status)
            .toBe(403);
    });
});

describe('readPublicHost', () => {
    it('reads the lowercase host with its port', () => {
        expect(readPublicHost('https://Bot.Example.com:8443/path'))
            .toBe('bot.example.com:8443');
    });

    it('returns nothing for a missing or unreadable address', () => {
        expect([readPublicHost(undefined), readPublicHost(''), readPublicHost('not a url')])
            .toEqual([undefined, undefined, undefined]);
    });
});
