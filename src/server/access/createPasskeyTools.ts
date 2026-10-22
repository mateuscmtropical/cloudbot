import { z } from 'zod/v4';

import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import type { PasskeySummary } from './PasskeyService.ts';

interface PasskeyToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

interface PasskeyToolsOptions {
    list: () => Promise<PasskeySummary[]>;
    // Each posts a card with a button. The browser adds or removes the passkey only after the owner taps it.
    postAddCard: () => Promise<void>;
    postRemoveCard: (passkey: PasskeySummary) => Promise<void>;
}

const PASSKEY_TOOL_FULL_NAMES = ['mcp__cloudbot__passkey_add', 'mcp__cloudbot__passkey_list', 'mcp__cloudbot__passkey_remove'];
const ADD_DESCRIPTION = 'Use this when the owner asks to sign in with a passkey, or to add a phone, computer or security key. It posts a card in the chat with a button. The browser makes the passkey only after the owner taps it, so you cannot add one yourself.';
const LIST_DESCRIPTION = 'Lists the passkeys the owner can sign in with: name, id, when it was added and when it was last used.';
const REMOVE_DESCRIPTION = 'Use this when the owner asks to remove a passkey. Pass its id from passkey_list. It posts a card in the chat, and the passkey is removed only after the owner taps it.';
const CARD_DONE_TEXT = 'The card is in the chat. Tell the owner in one short sentence to tap it, then stop.';

function textResult(text: string, isError = false): PasskeyToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function describePasskey(passkey: PasskeySummary): string {
    const added = new Date(passkey.createdAt)
        .toISOString();
    const used = passkey.lastUsedAt === null
        ? 'never used'
        : `last used ${new Date(passkey.lastUsedAt)
            .toISOString()}`;

    return `- ${JSON.stringify(passkey.name)} (id ${passkey.id}), added ${added}, ${used}`;
}

function createPasskeyTools(options: PasskeyToolsOptions): CloudbotTool[] {
    const addTool = tool('passkey_add', ADD_DESCRIPTION, {}, async (): Promise<PasskeyToolResult> => {
        try {
            await options.postAddCard();

            return textResult(CARD_DONE_TEXT);
        } catch {
            return textResult('The card could not be posted.', true);
        }
    });
    const listTool = tool('passkey_list', LIST_DESCRIPTION, {}, async (): Promise<PasskeyToolResult> => {
        const passkeys = await options.list();
        const lines = passkeys.map(describePasskey);

        return textResult(lines.length === 0 ? 'The owner has no passkeys yet. Only the setup link signs in.' : lines.join('\n'));
    });
    const removeTool = tool('passkey_remove', REMOVE_DESCRIPTION, { id: z.string()
        .min(1) }, async (args): Promise<PasskeyToolResult> => {
        const passkeys = await options.list();
        const passkey = passkeys.find(candidate => candidate.id === args.id);

        if (passkey === undefined) {
            return textResult('No passkey has that id. Call passkey_list for the ids.', true);
        }

        try {
            await options.postRemoveCard(passkey);

            return textResult(CARD_DONE_TEXT);
        } catch {
            return textResult('The card could not be posted.', true);
        }
    });

    return [addTool, listTool, removeTool];
}

export { PASSKEY_TOOL_FULL_NAMES, createPasskeyTools };
export type { PasskeyToolsOptions };
