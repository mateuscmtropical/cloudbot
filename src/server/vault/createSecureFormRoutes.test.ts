import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSecureFormRoutes } from './createSecureFormRoutes.ts';
import { Vault } from './Vault.ts';

function postJson(app: Hono, path: string, body: string): Response | Promise<Response> {
    return app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
    });
}

describe('createSecureFormRoutes', () => {
    let folderPath: string;
    let vault: Vault;

    beforeEach(() => {
        folderPath = mkdtempSync(join(tmpdir(), 'cloudbot-secure-form-'));
        vault = new Vault(folderPath);
    });

    afterEach(() => {
        rmSync(folderPath, { recursive: true, force: true });
    });

    it('stores a valid value and does not echo it back', async () => {
        const app = createSecureFormRoutes(vault);
        const response = await postJson(app, '/api/secrets/ANTHROPIC_API_KEY', JSON.stringify({ value: 'sk-test-value' }));
        const responseText = await response.text();

        expect(response.status)
            .toBe(200);
        expect(JSON.parse(responseText))
            .toEqual({ saved: true });
        expect(responseText)
            .not.toContain('sk-test-value');
        expect(vault.get('ANTHROPIC_API_KEY'))
            .toBe('sk-test-value');
    });

    it('rejects a name that does not match the allowed pattern', async () => {
        const app = createSecureFormRoutes(vault);
        const response = await postJson(app, '/api/secrets/api_key', JSON.stringify({ value: 'sk-test-value' }));

        expect(response.status)
            .toBe(400);
        expect(vault.listNames())
            .toEqual([]);
    });

    it('rejects an empty value', async () => {
        const app = createSecureFormRoutes(vault);
        const response = await postJson(app, '/api/secrets/ANTHROPIC_API_KEY', JSON.stringify({ value: '' }));

        expect(response.status)
            .toBe(400);
        expect(vault.has('ANTHROPIC_API_KEY'))
            .toBe(false);
    });

    it('rejects a body that is not JSON', async () => {
        const app = createSecureFormRoutes(vault);
        const response = await postJson(app, '/api/secrets/ANTHROPIC_API_KEY', 'not json');

        expect(response.status)
            .toBe(400);
        expect(vault.listNames())
            .toEqual([]);
    });
});
