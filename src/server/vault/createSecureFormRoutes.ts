import { Hono } from 'hono';

import type { Vault } from './Vault.ts';

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

interface SecretSavedResponse {
    saved: true;
}

interface SecretErrorResponse {
    error: string;
}

function readSecretValue(requestBody: unknown): string | undefined {
    if (typeof requestBody !== 'object' || requestBody === null) {
        return undefined;
    }

    const candidate: unknown = Reflect.get(requestBody, 'value');

    return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function createSecureFormRoutes(vault: Vault): Hono {
    const routes = new Hono();

    routes.post('/api/secrets/:name', async (context) => {
        const secretName = context.req.param('name');

        if (!SECRET_NAME_PATTERN.test(secretName)) {
            const nameError: SecretErrorResponse = {
                error: 'Use capital letters, digits and underscores, starting with a letter. Up to 64 characters.',
            };

            return context.json(nameError, 400);
        }

        // Invalid JSON counts as a missing value, so it gets the same 400 as an empty body.
        let requestBody: unknown;

        try {
            requestBody = await context.req.json();
        } catch {
            requestBody = undefined;
        }

        const secretValue = readSecretValue(requestBody);

        if (secretValue === undefined) {
            const valueError: SecretErrorResponse = { error: 'Send a non-empty "value" string.' };

            return context.json(valueError, 400);
        }

        vault.set(secretName, secretValue);

        const savedResponse: SecretSavedResponse = { saved: true };

        return context.json(savedResponse);
    });

    return routes;
}

export { createSecureFormRoutes };
