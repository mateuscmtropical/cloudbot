import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import { BrowserError } from '../desktop/BrowserControl.ts';
import type { BrowserControl } from '../desktop/BrowserControl.ts';
import { SCREEN_HELD_BY_PERSON_MESSAGE } from '../desktop/ScreenHolder.ts';
import type { ScreenHolder } from '../desktop/ScreenHolder.ts';
import type { BotSecret } from './BotSecrets.ts';
import type { SecretToolResult } from './createSecretTools.ts';

// Reads one of this bot's saved secrets. The bot id is fixed by the caller.
type SecretReader = (name: string) => BotSecret | undefined;

const TYPE_SECRET_TOOL_NAME = 'browser_type_secret';
const TYPE_SECRET_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${TYPE_SECRET_TOOL_NAME}`;
const TYPE_SECRET_DESCRIPTION = 'Type a secret the owner saved through request_secret into the focused field of your browser. You never see the value. It works only when the page is on the site saved with the secret. Click the field first.';

const TYPE_SECRET_SHAPE = {
    name: z.string()
        .trim()
        .min(1),
};

function textResult(text: string, isError = false): SecretToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function createTypeSecretTool(browser: BrowserControl, readSecret: SecretReader, screen?: ScreenHolder): CloudbotTool<typeof TYPE_SECRET_SHAPE> {
    return tool(
        TYPE_SECRET_TOOL_NAME,
        TYPE_SECRET_DESCRIPTION,
        TYPE_SECRET_SHAPE,
        async (args): Promise<SecretToolResult> => {
            if (screen?.isPersonHolding === true) {
                return textResult(SCREEN_HELD_BY_PERSON_MESSAGE, true);
            }

            const secret = readSecret(args.name);

            if (secret === undefined) {
                return textResult(`No saved secret is named ${args.name}. Ask the owner for it with request_secret.`, true);
            }

            try {
                await browser.typeSecret(secret.site, secret.value);

                return textResult(`Typed ${args.name} into the focused field.`);
            } catch (error: unknown) {
                // Only BrowserError text goes back. It never holds the value.
                const message = error instanceof BrowserError ? error.message : 'The secret could not be typed.';

                return textResult(message, true);
            } finally {
                browser.takeDismissedDialogs();
            }
        },
    );
}

export { TYPE_SECRET_TOOL_FULL_NAME, createTypeSecretTool };
export type { SecretReader };
