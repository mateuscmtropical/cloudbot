import { Hono } from 'hono';

import type { BitwardenTestResult } from '../../shared/bitwarden.ts';
import { BitwardenError } from './BitwardenCli.ts';
import { checkBitwardenAccount } from './bitwardenAccount.ts';
import type { BitwardenVault } from './BitwardenVault.ts';

// These routes sit behind the session check. They keep the Bitwarden account of the owner in the vault and answer only
// whether one is saved and for which server. No secret goes back out, not even in an error.
interface BitwardenRoutesOptions {
    vault: Pick<BitwardenVault, 'status' | 'save' | 'forget' | 'test'>;
    hasBot: (botId: string) => Promise<boolean>;
}

interface BitwardenErrorResponse {
    error: string;
}

const BITWARDEN_PATH = '/api/apps/bitwarden/account';
const BITWARDEN_TEST_PATH = '/api/apps/bitwarden/test';
const BOT_NOT_FOUND: BitwardenErrorResponse = { error: 'No bot has this id.' };
const INVALID_BOT: BitwardenErrorResponse = { error: 'Send the id of a bot.' };
const NOT_SET_UP = 'Bitwarden is not set up for this bot.';
const TEST_FAILED = 'The connection test could not run.';

function readText(requestBody: unknown, key: string): unknown {
    return typeof requestBody === 'object' && requestBody !== null ? Reflect.get(requestBody, key) : undefined;
}

async function readJsonBody(request: Request): Promise<unknown> {
    try {
        return await request.json();
    } catch {
        return undefined;
    }
}

function createBitwardenRoutes(options: BitwardenRoutesOptions): Hono {
    const routes = new Hono();

    routes.get(BITWARDEN_PATH, async (context) => {
        const botId = context.req.query('bot')
            ?.trim() ?? '';

        if (botId.length === 0) {
            return context.json(INVALID_BOT, 400);
        }

        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const status = options.vault.status(botId);

        return context.json(status);
    });

    routes.put(BITWARDEN_PATH, async (context) => {
        const requestBody = await readJsonBody(context.req.raw);
        const rawBotId = readText(requestBody, 'botId');
        const botId = typeof rawBotId === 'string' ? rawBotId.trim() : '';

        if (botId.length === 0) {
            return context.json(INVALID_BOT, 400);
        }

        const checked = checkBitwardenAccount({
            serverUrl: readText(requestBody, 'serverUrl'),
            clientId: readText(requestBody, 'clientId'),
            clientSecret: readText(requestBody, 'clientSecret'),
            masterPassword: readText(requestBody, 'masterPassword'),
        });

        if (!checked.ok) {
            return context.json({ error: checked.error }, 400);
        }

        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        await options.vault.save(botId, checked.account);

        const status = options.vault.status(botId);

        return context.json(status);
    });

    routes.delete(BITWARDEN_PATH, async (context) => {
        const botId = context.req.query('bot')
            ?.trim() ?? '';

        if (botId.length === 0) {
            return context.json(INVALID_BOT, 400);
        }

        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        await options.vault.forget(botId);

        return context.body(null, 204);
    });

    // Signs in, unlocks and syncs. The answer is ok, or one sentence that BitwardenCli wrote without any secret.
    routes.post(BITWARDEN_TEST_PATH, async (context) => {
        const requestBody = await readJsonBody(context.req.raw);
        const rawBotId = readText(requestBody, 'botId');
        const botId = typeof rawBotId === 'string' ? rawBotId.trim() : '';

        if (botId.length === 0) {
            return context.json(INVALID_BOT, 400);
        }

        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        if (!options.vault.status(botId).configured) {
            const notSetUp: BitwardenTestResult = { ok: false, error: NOT_SET_UP };

            return context.json(notSetUp);
        }

        try {
            await options.vault.test(botId);

            const passed: BitwardenTestResult = { ok: true };

            return context.json(passed);
        } catch (error: unknown) {
            const failed: BitwardenTestResult = { ok: false, error: error instanceof BitwardenError ? error.message : TEST_FAILED };

            return context.json(failed);
        }
    });

    return routes;
}

export { createBitwardenRoutes };
export type { BitwardenRoutesOptions };
