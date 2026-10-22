import { describe, expect, it, vi } from 'vitest';

import { createPushSender } from './createPushSender.ts';
import type { PushSendDeps } from './createPushSender.ts';

function buildDeps(addresses: string[], status = 201): { deps: PushSendDeps; request: ReturnType<typeof vi.fn> } {
    const request = vi.fn<PushSendDeps['request']>(() => Promise.resolve(new Response(null, { status })));
    const deps: PushSendDeps = {
        resolve: () => Promise.resolve(addresses),
        request,
        localAddresses: [],
    };

    return { deps, request };
}

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';

describe('createPushSender', () => {
    it('posts the body to the checked address and returns the status', async () => {
        const { deps, request } = buildDeps(['142.250.0.1'], 201);
        const send = createPushSender(deps);
        const body = Buffer.from([1, 2, 3]);
        const status = await send({ endpoint: ENDPOINT, headers: { TTL: '3600' }, body });

        expect(status)
            .toBe(201);
        expect(request)
            .toHaveBeenCalledTimes(1);

        const [url, init, addresses] = request.mock.calls[0] as [URL, RequestInit, string[]];

        expect(url.href)
            .toBe(ENDPOINT);
        expect(init.method)
            .toBe('POST');
        expect(init.headers)
            .toEqual({ TTL: '3600' });
        expect(Buffer.from(init.body as Uint8Array))
            .toEqual(body);
        expect(addresses)
            .toEqual(['142.250.0.1']);
    });

    it('returns an error status such as 410 so the caller can drop the subscription', async () => {
        const { deps } = buildDeps(['142.250.0.1'], 410);
        const send = createPushSender(deps);

        await expect(send({ endpoint: ENDPOINT, headers: {}, body: Buffer.alloc(1) }))
            .resolves.toBe(410);
    });

    it('refuses an endpoint that is not a known push service before any lookup', async () => {
        const { deps, request } = buildDeps(['142.250.0.1']);
        const resolve = vi.fn(deps.resolve);
        const send = createPushSender({ ...deps, resolve });

        await expect(send({ endpoint: 'https://example.com/push', headers: {}, body: Buffer.alloc(1) }))
            .rejects.toThrow('not a known push service');
        expect(resolve)
            .not.toHaveBeenCalled();
        expect(request)
            .not.toHaveBeenCalled();
    });

    it.each([
        ['loopback', ['127.0.0.1']],
        ['private', ['10.0.0.5']],
        ['metadata', ['169.254.169.254']],
        ['one private address among public ones', ['142.250.0.1', '192.168.1.1']],
        ['no address', []],
    ])('refuses a push service name that resolves to %s', async (_label, addresses) => {
        const { deps, request } = buildDeps(addresses);
        const send = createPushSender(deps);

        await expect(send({ endpoint: ENDPOINT, headers: {}, body: Buffer.alloc(1) }))
            .rejects.toThrow('private or reserved');
        expect(request)
            .not.toHaveBeenCalled();
    });

    it('turns a failed lookup into a push send error', async () => {
        const { deps } = buildDeps([]);
        const send = createPushSender({ ...deps, resolve: () => Promise.reject(new Error('ENOTFOUND')) });

        await expect(send({ endpoint: ENDPOINT, headers: {}, body: Buffer.alloc(1) }))
            .rejects.toThrow('could not be found');
    });
});
