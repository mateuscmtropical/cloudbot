import { describe, expect, it } from 'vitest';

import { createGalleryTransport } from './galleryTransport.ts';
import type { GalleryTransportDeps } from './galleryTransport.ts';
import { GalleryError } from './templateGallery.ts';
import type { GalleryRequest } from './templateGallery.ts';

const PUBLIC_ADDRESS = '93.184.216.34';
const SENT_BY_PATH = 'https://api.github.com/repos/owner/templates';

interface SentRequest {
    url: URL;
    init: RequestInit;
    addresses: string[];
}

interface FakeNetwork {
    deps: GalleryTransportDeps;
    sent: SentRequest[];
}

// Fake resolver and sender. The sender answers with the response it is given, and records the call.
function fakeNetwork(addresses: string[], response: () => Response): FakeNetwork {
    const sent: SentRequest[] = [];
    const deps: GalleryTransportDeps = {
        resolve: () => Promise.resolve(addresses),
        send: (url, init, checkedAddresses) => {
            sent.push({ url, init, addresses: checkedAddresses });

            return Promise.resolve(response());
        },
        localAddresses: [],
    };

    return { deps, sent };
}

function requestTo(address: string, token?: string): GalleryRequest {
    return {
        method: 'GET',
        url: new URL(address),
        accept: 'application/vnd.github+json',
        token,
        body: undefined,
    };
}

describe('createGalleryTransport', () => {
    it('reads only https to api.github.com, and sends nothing for any other address', async () => {
        const network = fakeNetwork([PUBLIC_ADDRESS], () => new Response('{}', { status: 200 }));
        const transport = createGalleryTransport(network.deps);

        await expect(transport(requestTo('http://api.github.com/repos/owner/templates')))
            .rejects
            .toBeInstanceOf(GalleryError);
        await expect(transport(requestTo('https://example.com/repos/owner/templates')))
            .rejects
            .toBeInstanceOf(GalleryError);
        expect(network.sent)
            .toHaveLength(0);
    });

    it('refuses a host name that resolves to a private address, and sends nothing', async () => {
        const network = fakeNetwork(['10.0.0.5'], () => new Response('{}', { status: 200 }));
        const transport = createGalleryTransport(network.deps);

        await expect(transport(requestTo(SENT_BY_PATH)))
            .rejects
            .toThrow('could not be checked');
        expect(network.sent)
            .toHaveLength(0);
    });

    it('refuses when one of the addresses is private, even if the others are public', async () => {
        const network = fakeNetwork([PUBLIC_ADDRESS, '127.0.0.1'], () => new Response('{}', { status: 200 }));
        const transport = createGalleryTransport(network.deps);

        await expect(transport(requestTo(SENT_BY_PATH)))
            .rejects
            .toBeInstanceOf(GalleryError);
        expect(network.sent)
            .toHaveLength(0);
    });

    it('sends to the checked addresses and returns the status and the text', async () => {
        const network = fakeNetwork([PUBLIC_ADDRESS], () => new Response('{"name":"ana.json"}', { status: 200 }));
        const transport = createGalleryTransport(network.deps);

        const reply = await transport(requestTo(SENT_BY_PATH));

        expect(reply)
            .toEqual({ status: 200, text: '{"name":"ana.json"}' });
        expect(network.sent[0]?.addresses)
            .toEqual([PUBLIC_ADDRESS]);
    });

    it('sends the token only as a bearer header, and no header when there is no token', async () => {
        const network = fakeNetwork([PUBLIC_ADDRESS], () => new Response('{}', { status: 200 }));
        const transport = createGalleryTransport(network.deps);

        await transport(requestTo(SENT_BY_PATH, 'fake-token-1'));
        await transport(requestTo(SENT_BY_PATH));
        const withToken = network.sent[0]?.init.headers as Record<string, string>;
        const withoutToken = network.sent[1]?.init.headers as Record<string, string>;

        expect(withToken.Authorization)
            .toBe('Bearer fake-token-1');
        expect(withoutToken)
            .not.toHaveProperty('Authorization');
    });

    it('refuses a redirect, so the token never goes to an address the bot did not choose', async () => {
        const network = fakeNetwork([PUBLIC_ADDRESS], () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
        const transport = createGalleryTransport(network.deps);

        await expect(transport(requestTo(SENT_BY_PATH, 'fake-token-1')))
            .rejects
            .toThrow('redirect');
    });

    it('refuses an answer over 1 MB', async () => {
        const network = fakeNetwork([PUBLIC_ADDRESS], () => new Response('x'.repeat(1024 * 1024 + 10), { status: 200 }));
        const transport = createGalleryTransport(network.deps);

        await expect(transport(requestTo(SENT_BY_PATH)))
            .rejects
            .toThrow('larger than 1 MB');
    });
});
