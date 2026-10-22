import { describe, expect, it } from 'vitest';

import { TELEGRAM_TOKEN_SECRET_NAME, createTelegramTools } from './createTelegramTools.ts';
import type { TelegramConnector, TelegramToolResult } from './createTelegramTools.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<TelegramToolResult>;

function handlers(connector: TelegramConnector): { connect: ToolHandler; disconnect: ToolHandler } {
    const [connectTool, disconnectTool] = createTelegramTools(connector, 'bot-1');

    if (connectTool === undefined || disconnectTool === undefined) {
        throw new Error('Missing tools.');
    }

    return { connect: connectTool.handler as unknown as ToolHandler, disconnect: disconnectTool.handler as unknown as ToolHandler };
}

describe('createTelegramTools', () => {
    it('tells the bot to ask for the token when none is saved', async () => {
        const { connect } = handlers({ startPairing: () => Promise.resolve(false), disconnect: () => Promise.resolve(false) });
        const result = await connect({}, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toContain(TELEGRAM_TOKEN_SECRET_NAME);
    });

    it('never gives the code to the bot', async () => {
        const { connect } = handlers({ startPairing: () => Promise.resolve(true), disconnect: () => Promise.resolve(false) });
        const result = await connect({}, {});

        expect(result.isError)
            .toBeUndefined();
        expect(result.content[0]?.text)
            .toContain('one-time code is in the chat');
    });

    it('reports an error without its cause', async () => {
        const { connect, disconnect } = handlers({ startPairing: () => Promise.reject(new Error('secret detail')), disconnect: () => Promise.reject(new Error('secret detail')) });
        const results = await Promise.all([connect({}, {}), disconnect({}, {})]);

        expect(results.map(result => result.isError))
            .toEqual([true, true]);
        expect(JSON.stringify(results))
            .not.toContain('secret detail');
    });

    it('says whether Telegram was connected', async () => {
        const { disconnect } = handlers({ startPairing: () => Promise.resolve(true), disconnect: () => Promise.resolve(true) });
        const result = await disconnect({}, {});

        expect(result.content[0]?.text)
            .toBe('Telegram is disconnected.');
    });
});
