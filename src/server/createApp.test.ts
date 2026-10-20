import { describe, expect, it } from 'vitest';

import { createApp } from './createApp.ts';

describe('createApp', () => {
    it('answers the health route with the version', async () => {
        const app = createApp({ version: '1.2.3' });
        const response = await app.request('/api/health');

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual({ status: 'ok', version: '1.2.3' });
    });

    it('answers unknown routes with 404', async () => {
        const app = createApp({ version: '1.2.3' });
        const response = await app.request('/api/missing');

        expect(response.status)
            .toBe(404);
    });
});
