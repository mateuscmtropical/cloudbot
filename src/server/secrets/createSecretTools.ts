import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import { BotSecretError } from './BotSecrets.ts';

interface SecretToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

// Posts the secure form. It throws BotSecretError with a message for the model.
type SecretRequestHandler = (name: string, purpose: string, site: string) => Promise<{ site: string }>;

const REQUEST_SECRET_TOOL_NAME = 'request_secret';
const REQUEST_SECRET_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${REQUEST_SECRET_TOOL_NAME}`;
const MAX_PURPOSE_LENGTH = 300;
const REQUEST_SECRET_DESCRIPTION = 'Ask the owner for a password, a one-time code or a payment detail through a secure form in the chat. The value goes to the vault and you never see it. Give a NAME in capital letters, a short purpose the owner will read, and the https site where the value will be used. After you ask, tell the owner to fill in the form and stop until they answer.';

const REQUEST_SECRET_SHAPE = {
    name: z.string()
        .trim()
        .min(1),
    purpose: z.string()
        .trim()
        .min(1)
        .max(MAX_PURPOSE_LENGTH),
    site: z.string()
        .trim()
        .min(1),
};

function textResult(text: string, isError = false): SecretToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function createRequestSecretTool(requestSecret: SecretRequestHandler): CloudbotTool<typeof REQUEST_SECRET_SHAPE> {
    return tool(
        REQUEST_SECRET_TOOL_NAME,
        REQUEST_SECRET_DESCRIPTION,
        REQUEST_SECRET_SHAPE,
        async (args): Promise<SecretToolResult> => {
            try {
                const requested = await requestSecret(args.name, args.purpose, args.site);

                return textResult(`A secure form for ${args.name} on ${requested.site} is in the chat. The owner fills it in. You will not see the value.`);
            } catch (error: unknown) {
                if (error instanceof BotSecretError) {
                    return textResult(error.message, true);
                }

                return textResult('The secure form could not be posted.', true);
            }
        },
    );
}

export { MAX_PURPOSE_LENGTH, REQUEST_SECRET_TOOL_FULL_NAME, createRequestSecretTool };
export type { SecretRequestHandler, SecretToolResult };
