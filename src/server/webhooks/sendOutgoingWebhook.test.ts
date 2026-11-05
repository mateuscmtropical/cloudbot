import { describe, expect, it, vi } from 'vitest';

import { MAX_ANSWER_CHARACTERS, createOutgoingWebhookSender } from './sendOutgoingWebhook.ts';
import type { OutgoingWebhookDeps } from './sendOutgoingWebhook.ts';

function makeDeps(answer: Response, addresses: string[] = ['93.184.216.34']): OutgoingWebhookDeps & { send: ReturnType<typeof vi.fn> } {
    return {
        resolve: () => Promise.resolve(addresses),
        send: vi.fn(() => Promise.resolve(answer)),
        localAddresses: [],
    };
}

describe('createOutgoingWebhookSender', () => {
    it('posts JSON by default, to the addresses it checked, and returns the answer', async () => {
        const deps = makeDeps(new Response('ok', { status: 200 }));
        const send = createOutgoingWebhookSender(deps);

        await expect(send({ url: 'https://hooks.example.com/a?b=1', body: '{"a":1}' }))
            .resolves.toEqual({ status: 200, text: 'ok' });

        const [url, init, addresses] = deps.send.mock.calls[0] as [URL, RequestInit, string[]];

        expect(url.href)
            .toBe('https://hooks.example.com/a?b=1');
        expect(init)
            .toMatchObject({ method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
        expect(addresses)
            .toEqual(['93.184.216.34']);
    });

    it('keeps the headers it was given except the ones the connection sets', async () => {
        const deps = makeDeps(new Response(null, { status: 204 }));
        const send = createOutgoingWebhookSender(deps);

        await send({ url: 'https://hooks.example.com/', method: 'PUT', body: 'x', headers: { 'Host': 'other.example.com', 'Content-Type': 'text/plain', 'X-Key': 'v' } });

        const init = (deps.send.mock.calls[0] as [URL, RequestInit])[1];

        expect(init.method)
            .toBe('PUT');
        expect(init.headers)
            .toEqual({ 'user-agent': 'CloudBot webhook', 'Content-Type': 'text/plain', 'X-Key': 'v' });
    });

    it.each([
        ['a private address', 'http://127.0.0.1/hook', ['127.0.0.1']],
        ['a name that resolves to a private address', 'https://inside.example.com/', ['10.0.0.5']],
        ['a name with a mix of addresses', 'https://mixed.example.com/', ['93.184.216.34', '169.254.169.254']],
        ['a name that resolves to nothing', 'https://none.example.com/', []],
        ['another protocol', 'file:///etc/passwd', ['93.184.216.34']],
        ['text that is no address', 'not an address', ['93.184.216.34']],
    ])('sends nothing to %s', async (_name, url, addresses) => {
        const deps = makeDeps(new Response('ok'), addresses);
        const send = createOutgoingWebhookSender(deps);

        await expect(send({ url }))
            .rejects.toThrow();
        expect(deps.send).not.toHaveBeenCalled();
    });

    it('refuses a body over the limit', async () => {
        const deps = makeDeps(new Response('ok'));
        const send = createOutgoingWebhookSender(deps);

        await expect(send({ url: 'https://hooks.example.com/', body: 'x'.repeat(64 * 1024 + 1) }))
            .rejects.toThrow('64 KB');
        expect(deps.send).not.toHaveBeenCalled();
    });

    it('shortens a long answer and does not follow a redirect', async () => {
        const long = createOutgoingWebhookSender(makeDeps(new Response('x'.repeat(MAX_ANSWER_CHARACTERS + 10))));
        const moved = makeDeps(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }));
        const redirected = createOutgoingWebhookSender(moved);
        const longAnswer = await long({ url: 'https://hooks.example.com/' });

        expect(longAnswer.text)
            .toHaveLength(MAX_ANSWER_CHARACTERS);
        await expect(redirected({ url: 'https://hooks.example.com/' }))
            .resolves.toMatchObject({ status: 302 });
        expect(moved.send)
            .toHaveBeenCalledTimes(1);
    });
});
