import { describe, expect, it } from 'vitest';

import type { MessengerToolResult } from '../messenger/createMessengerTools.ts';
import { DISCORD_TOKEN_SECRET_NAME, DISCORD_TOOL_FULL_NAMES, createDiscordTools } from './createDiscordTools.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<MessengerToolResult>;

describe('createDiscordTools', () => {
    it('offers connect and disconnect tools named for Discord', () => {
        const tools = createDiscordTools({ startPairing: () => Promise.resolve(true), disconnect: () => Promise.resolve(true) }, 'bot-1');

        expect(tools.map(tool => tool.name))
            .toEqual(['discord_connect', 'discord_disconnect']);
        expect(DISCORD_TOOL_FULL_NAMES.map(name => name.endsWith('discord_connect') || name.endsWith('discord_disconnect')))
            .toEqual([true, true]);
    });

    it('tells the bot to ask for the Discord token when none is saved', async () => {
        const [connectTool] = createDiscordTools({ startPairing: () => Promise.resolve(false), disconnect: () => Promise.resolve(false) }, 'bot-1');
        const result = await (connectTool?.handler as unknown as ToolHandler)({}, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toContain(DISCORD_TOKEN_SECRET_NAME);
    });
});
