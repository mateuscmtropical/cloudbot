import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

import type { CloudbotTool, ProfileToolResult } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';

const BOT_EXPORT_TOOL_NAME = 'bot_export';
const BOT_IMPORT_TOOL_NAME = 'bot_import';
const BOT_EXPORT_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${BOT_EXPORT_TOOL_NAME}`;
const BOT_IMPORT_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${BOT_IMPORT_TOOL_NAME}`;

const EXPORT_DESCRIPTION = 'Export yourself as a template file, shared in the chat. The file holds your name, title, description, look, rules and routines. It never holds secrets, sign-ins, webhook addresses, shared files or learned memory. Use it when the owner asks for a copy of you.';
const IMPORT_DESCRIPTION = 'Create a new bot from a template file the owner attached in this chat. Pass the path the attachment was given. The owner sees the whole template and approves it before the bot is made. Its routines start turned off, and it has no secrets.';

const EXPORT_SHAPE = {};
const BOT_IMPORT_SHAPE = {
    path: z.string()
        .min(1)
        .max(4096),
};

interface ExportedTemplate {
    name: string;
}

interface ImportedBot {
    name: string;
}

// The message goes to the bot, so it can tell the owner what to fix.
function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

function textResult(text: string, isError: boolean): ProfileToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

// The handlers are the ChatService's. The export shares the file in the chat, and the import checks the file first.
function createBotExportTool(exportBot: () => Promise<ExportedTemplate>): CloudbotTool {
    return tool(
        BOT_EXPORT_TOOL_NAME,
        EXPORT_DESCRIPTION,
        EXPORT_SHAPE,
        async (): Promise<ProfileToolResult> => {
            try {
                const exported = await exportBot();

                return textResult(`The template of ${exported.name} is shared in the chat.`, false);
            } catch (error: unknown) {
                const exportMessage = errorMessage(error, 'The template could not be exported.');

                return textResult(exportMessage, true);
            }
        },
    );
}

function createBotImportTool(importBot: (path: string) => Promise<ImportedBot>): CloudbotTool {
    return tool(
        BOT_IMPORT_TOOL_NAME,
        IMPORT_DESCRIPTION,
        BOT_IMPORT_SHAPE,
        async (args): Promise<ProfileToolResult> => {
            try {
                const imported = await importBot(args.path);

                return textResult(`Created the bot ${imported.name} from the template. Its routines are off. The owner can open it from the bot list.`, false);
            } catch (error: unknown) {
                const importMessage = errorMessage(error, 'The template could not be imported.');

                return textResult(importMessage, true);
            }
        },
    );
}

export { BOT_EXPORT_TOOL_FULL_NAME, BOT_IMPORT_SHAPE, BOT_IMPORT_TOOL_FULL_NAME, createBotExportTool, createBotImportTool };
export type { ExportedTemplate, ImportedBot };
