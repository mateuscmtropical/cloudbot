import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { CONTENT_SECURITY_POLICY, createSecurityHeaders } from './securityHeaders.ts';

function createApp(): Hono {
    const app = new Hono();

    app.use('*', createSecurityHeaders());
    app.get('/', context => context.html('<div id="root"></div>'));
    app.get('/stream', () => new Response('data: 1\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    app.post('/api/thing', context => context.json({ ok: true }));

    return app;
}

describe('createSecurityHeaders', () => {
    it('sets the content security policy of the built web app', async () => {
        const response = await createApp()
            .request('/');
        const policy = response.headers.get('content-security-policy') ?? '';

        expect(policy)
            .toContain('default-src \'self\'');
        expect(policy)
            .toContain('script-src \'self\'');
        expect(policy)
            .toContain('img-src \'self\' data:');
        expect(policy)
            .toContain('connect-src \'self\'');
        expect(policy)
            .toContain('object-src \'none\'');
        expect(policy)
            .toContain('base-uri \'none\'');
        expect(policy)
            .toContain('frame-ancestors \'none\'');
    });

    it('names the socket origins of the request host, so older Safari can open the live screen', async () => {
        const app = createApp();
        const local = await app.request('http://localhost:3000/');
        const lan = await app.request('http://192.168.0.5:3000/');
        const localPolicy = local.headers.get('content-security-policy') ?? '';
        const lanPolicy = lan.headers.get('content-security-policy') ?? '';

        expect(localPolicy)
            .toContain('ws://localhost:3000 wss://localhost:3000');
        expect(lanPolicy)
            .toContain('ws://192.168.0.5:3000 wss://192.168.0.5:3000');
        expect(localPolicy)
            .not.toContain('192.168.0.5');
    });

    it('also names the socket origins of the public address', async () => {
        const app = new Hono();

        app.use('*', createSecurityHeaders('bot.example.com'));
        app.get('/', context => context.html('<div id="root"></div>'));

        const response = await app.request('/');
        const policy = response.headers.get('content-security-policy') ?? '';

        expect(policy)
            .toContain('ws://bot.example.com wss://bot.example.com');
    });

    it('leaves out a host that could change the policy', async () => {
        const response = await createApp()
            .request('http://evil;script-src/');
        const policy = response.headers.get('content-security-policy') ?? '';

        expect(policy)
            .not.toContain('evil');
    });

    it('allows no inline script and no inline style element', () => {
        expect(CONTENT_SECURITY_POLICY.scriptSrc)
            .toEqual(['\'self\'']);
        expect(CONTENT_SECURITY_POLICY.styleSrc)
            .toEqual(['\'self\'']);
    });

    it('forbids framing, sniffing and the referrer', async () => {
        const response = await createApp()
            .request('/');

        expect(response.headers.get('x-frame-options'))
            .toBe('DENY');
        expect(response.headers.get('x-content-type-options'))
            .toBe('nosniff');
        expect(response.headers.get('referrer-policy'))
            .toBe('no-referrer');
        expect(response.headers.get('cross-origin-opener-policy'))
            .toBe('same-origin');
    });

    it('leaves HSTS to the proxy in front of the server', async () => {
        const response = await createApp()
            .request('/');

        expect(response.headers.get('strict-transport-security'))
            .toBeNull();
    });

    it('also covers API answers and streams', async () => {
        const app = createApp();
        const api = await app.request('/api/thing', { method: 'POST' });
        const stream = await app.request('/stream');

        expect(api.headers.get('content-security-policy'))
            .toContain('frame-ancestors \'none\'');
        expect(stream.headers.get('content-security-policy'))
            .toContain('frame-ancestors \'none\'');
        expect(await stream.text())
            .toBe('data: 1\n\n');
    });
});
