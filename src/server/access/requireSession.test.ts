import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import type { SetupAccess } from './SetupAccess.ts';
import { requireSession } from './requireSession.ts';

function createProtectedApp(secret: string): Hono {
    const access = { isValidSession: vi.fn(() => Promise.resolve(false)) } as unknown as SetupAccess;
    const app = new Hono();

    app.use('/private', requireSession(access, secret));
    app.get('/private', context => context.text('ok'));

    return app;
}

describe('requireSession in hub mode', () => {
    it('accepts the right hub secret', async () => {
        const app = createProtectedApp('instance-secret');
        const response = await app.request('/private', { headers: { 'x-cloudbot-hub': 'instance-secret' } });

        expect(response.status)
            .toBe(200);
        expect(await response.text())
            .toBe('ok');
    });

    it('refuses a wrong, missing or wrong length hub secret', async () => {
        const app = createProtectedApp('instance-secret');
        const wrong = await app.request('/private', { headers: { 'x-cloudbot-hub': 'wrong-secret!' } });
        const missing = await app.request('/private');
        const wrongLength = await app.request('/private', { headers: { 'x-cloudbot-hub': 'short' } });

        expect(wrong.status)
            .toBe(401);
        expect(missing.status)
            .toBe(401);
        expect(wrongLength.status)
            .toBe(401);
    });
});

export {};
