import { Hono } from 'hono';

import { ACTING_PERSON_HEADER, HUB_BOT_TEMPLATE_PATH, HUB_TRUST_HEADER } from '../../shared/hubProtocol.ts';
import { isValidHubSecret } from '../access/hubSession.ts';

interface BotTemplateRouteOptions {
    hubSecret: string;
    // Makes the bot from the template text. Throws with a reason the hub may show when the template is refused.
    importTemplate: (text: string) => Promise<{ name: string }>;
}

interface BotTemplateError {
    error: string;
}

// Only the hub itself calls this, with the secret and without a person. A browser request through the hub always names
// the person who acts, so a member cannot add a bot here past the group's roles.
function createBotTemplateRoute(options: BotTemplateRouteOptions): Hono {
    const routes = new Hono();

    routes.post(HUB_BOT_TEMPLATE_PATH, async (context) => {
        const presentedSecret = context.req.header(HUB_TRUST_HEADER);
        const isFromHub = isValidHubSecret(presentedSecret, options.hubSecret) && context.req.header(ACTING_PERSON_HEADER) === undefined;

        if (!isFromHub) {
            const refusal: BotTemplateError = { error: 'Only the hub may send a bot here.' };

            return context.json(refusal, 403);
        }

        const body: unknown = await context.req.json()
            .catch(() => undefined);
        const template: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'template') : undefined;

        if (typeof template !== 'string') {
            const missing: BotTemplateError = { error: 'Send the bot template as text.' };

            return context.json(missing, 400);
        }

        try {
            const made = await options.importTemplate(template);

            return context.json(made, 201);
        } catch (error: unknown) {
            const reason: BotTemplateError = { error: error instanceof Error ? error.message : 'The bot could not be made.' };

            return context.json(reason, 409);
        }
    });

    return routes;
}

export { createBotTemplateRoute };
