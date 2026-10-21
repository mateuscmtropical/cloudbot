import { describe, expect, it } from 'vitest';

import type { ProfileToolResult } from '../agent/createProfileToolServer.ts';
import type { BotSendInput, BotSendOutcome } from './createBotSendTool.ts';
import { BOT_SEND_TOOL_FULL_NAME, createBotSendTool } from './createBotSendTool.ts';

interface ToolHandle {
    name: string;
    handler: (input: BotSendInput) => Promise<ProfileToolResult>;
}

describe('bot_send tool', () => {
    it('passes the target and text to the handler and returns its outcome as the tool result', async () => {
        const receivedInputs: BotSendInput[] = [];
        const outcome: BotSendOutcome = { isError: true, text: 'No bot is named Nobody.' };
        const tool = createBotSendTool((input) => {
            receivedInputs.push(input);

            return Promise.resolve(outcome);
        }) as unknown as ToolHandle;

        const result = await tool.handler({ bot: 'Nobody', text: 'Hello' });

        expect(tool.name)
            .toBe('bot_send');
        expect(BOT_SEND_TOOL_FULL_NAME)
            .toBe('mcp__cloudbot__bot_send');
        expect(receivedInputs)
            .toEqual([{ bot: 'Nobody', text: 'Hello' }]);
        expect(result)
            .toEqual({ content: [{ type: 'text', text: 'No bot is named Nobody.' }], isError: true });
    });
});
