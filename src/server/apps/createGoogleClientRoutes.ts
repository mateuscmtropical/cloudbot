import { Hono } from 'hono';

import type { GoogleClientStatus } from '../../shared/connectedApps.ts';
import type { GoogleClientStore } from './googleClient.ts';

// These routes sit behind the session check. They keep the Google Cloud client of the owner in the vault and
// answer only whether one is saved. The secret never goes back out.
interface GoogleClientRoutesOptions {
    client: Pick<GoogleClientStore, 'read' | 'save' | 'forget'>;
    redirectUri: string;
    hasBot: (botId: string) => Promise<boolean>;
}

interface GoogleClientErrorResponse {
    error: string;
}

const GOOGLE_CLIENT_PATH = '/api/apps/google/client';
const BOT_NOT_FOUND: GoogleClientErrorResponse = { error: 'No bot has this id.' };
const INVALID_BOT: GoogleClientErrorResponse = { error: 'Send the id of a bot.' };
const INVALID_CLIENT_ID: GoogleClientErrorResponse = { error: 'The client ID must end with .apps.googleusercontent.com.' };
const INVALID_CLIENT_SECRET: GoogleClientErrorResponse = { error: 'The client secret must be 8 to 256 characters without spaces.' };
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET_PATTERN = /^\S{8,256}$/;

function readText(requestBody: unknown, key: string): string | undefined {
    if (typeof requestBody !== 'object' || requestBody === null) {
        return undefined;
    }

    const value: unknown = Reflect.get(requestBody, key);

    return typeof value === 'string' ? value.trim() : undefined;
}

function createGoogleClientRoutes(options: GoogleClientRoutesOptions): Hono {
    const routes = new Hono();

    function createStatus(botId: string): GoogleClientStatus {
        const saved = options.client.read(botId);

        return { configured: saved !== undefined, redirectUri: options.redirectUri };
    }

    routes.get(GOOGLE_CLIENT_PATH, async (context) => {
        const botId = context.req.query('bot')
            ?.trim() ?? '';

        if (botId.length === 0) {
            return context.json(INVALID_BOT, 400);
        }

        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const status = createStatus(botId);

        return context.json(status);
    });

    routes.put(GOOGLE_CLIENT_PATH, async (context) => {
        let requestBody: unknown;

        try {
            requestBody = await context.req.json();
        } catch {
            requestBody = undefined;
        }

        const botId = readText(requestBody, 'botId') ?? '';
        const clientId = readText(requestBody, 'clientId') ?? '';
        const clientSecret = readText(requestBody, 'clientSecret') ?? '';

        if (botId.length === 0) {
            return context.json(INVALID_BOT, 400);
        }

        if (!CLIENT_ID_PATTERN.test(clientId)) {
            return context.json(INVALID_CLIENT_ID, 400);
        }

        if (!CLIENT_SECRET_PATTERN.test(clientSecret)) {
            return context.json(INVALID_CLIENT_SECRET, 400);
        }

        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        options.client.save(botId, { clientId, clientSecret });

        const status = createStatus(botId);

        return context.json(status);
    });

    routes.delete(GOOGLE_CLIENT_PATH, async (context) => {
        const botId = context.req.query('bot')
            ?.trim() ?? '';

        if (botId.length === 0) {
            return context.json(INVALID_BOT, 400);
        }

        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        options.client.forget(botId);

        return context.body(null, 204);
    });

    return routes;
}

export { createGoogleClientRoutes };
export type { GoogleClientRoutesOptions };
