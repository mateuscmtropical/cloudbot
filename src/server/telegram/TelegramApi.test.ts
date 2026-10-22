import { describe, expect, it } from 'vitest';

import { MAX_MESSAGE_CHARACTERS, TelegramApiError, createTelegramApi, splitMessage } from './TelegramApi.ts';
import type { FetchFunction } from './TelegramApi.ts';

const FAKE_TOKEN = '123456:fake-token-for-tests';

function fakeFetch(answers: unknown[], calls: { url: string; body: unknown }[]): FetchFunction {
    return (url, init) => {
        calls.push({ url, body: JSON.parse(init.body as string) });

        const answer = answers.shift();

        if (answer instanceof Error) {
            return Promise.reject(answer);
        }

        return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
    };
}

describe('createTelegramApi', () => {
    it('asks for message updates with a long poll and reads them', async () => {
        const calls: { url: string; body: unknown }[] = [];
        const api = createTelegramApi(FAKE_TOKEN, fakeFetch([{ ok: true, result: [
            { update_id: 7, message: { chat: { id: 5, type: 'private' }, from: { id: 9 }, text: 'hi' } },
            { update_id: 8, edited_message: {} },
        ] }], calls));

        const updates = await api.getUpdates(3, 30, new AbortController().signal);

        expect(calls[0])
            .toEqual({ url: `https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates`, body: { offset: 3, timeout: 30, allowed_updates: ['message'] } });
        expect(updates)
            .toEqual([
                { update_id: 7, message: { chat: { id: 5, type: 'private' }, from: { id: 9 }, text: 'hi' } },
                { update_id: 8 },
            ]);
    });

    it('never puts the token in an error', async () => {
        const calls: { url: string; body: unknown }[] = [];
        const api = createTelegramApi(FAKE_TOKEN, fakeFetch([new Error(`fetch failed for https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates`), { ok: false, description: 'Unauthorized' }], calls));
        const signal = new AbortController().signal;
        const unreachable = await api.getUpdates(0, 30, signal)
            .catch((error: unknown) => error);
        const refused = await api.getUpdates(0, 30, signal)
            .catch((error: unknown) => error);

        expect(unreachable)
            .toBeInstanceOf(TelegramApiError);
        expect(refused)
            .toBeInstanceOf(TelegramApiError);
        expect(String(unreachable) + String(refused))
            .not.toContain('fake-token');
    });

    it('sends a long reply in parts, in order', async () => {
        const calls: { url: string; body: unknown }[] = [];
        const api = createTelegramApi(FAKE_TOKEN, fakeFetch([{ ok: true, result: {} }, { ok: true, result: {} }], calls));
        const text = 'a'.repeat(MAX_MESSAGE_CHARACTERS) + 'b';

        await api.sendMessage(5, text);
        expect(calls.map(call => call.body))
            .toEqual([{ chat_id: 5, text: 'a'.repeat(MAX_MESSAGE_CHARACTERS) }, { chat_id: 5, text: 'b' }]);
    });
});

describe('splitMessage', () => {
    it('keeps an emoji whole at the cut', () => {
        const text = 'a'.repeat(MAX_MESSAGE_CHARACTERS - 1) + '😀😀';
        const parts = splitMessage(text);

        expect(parts.map(part => Array.from(part).length))
            .toEqual([MAX_MESSAGE_CHARACTERS, 1]);
        expect(parts.join(''))
            .toBe(text);
    });
});
