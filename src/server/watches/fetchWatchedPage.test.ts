import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkWatchUrl, createPinnedLookup, fetchWatchedPage } from './fetchWatchedPage.ts';
import type { PageFetchDeps, PageResponse } from './fetchWatchedPage.ts';

interface Requested {
    url: string;
    addresses: string[];
}

// Fake resolver and request. Nothing here touches the network. `answer` decides each response from the URL and addresses.
function createDeps(addressesByHost: Record<string, string[]>, answer: (url: URL, addresses: string[]) => Promise<PageResponse>): { deps: PageFetchDeps; requested: Requested[] } {
    const requested: Requested[] = [];
    const deps: PageFetchDeps = {
        resolve: host => Promise.resolve(addressesByHost[host] ?? []),
        request: (url, addresses) => {
            requested.push({ url: url.href, addresses });

            return answer(url, addresses);
        },
        localAddresses: ['198.51.100.9'],
    };

    return { deps, requested };
}

function htmlPage(body: string): PageResponse {
    return { status: 200, contentType: 'text/html; charset=utf-8', body, tooLarge: false };
}

describe('fetchWatchedPage', () => {
    it('returns the visible text of an HTML page, fetched from the address it checked', async () => {
        const { deps, requested } = createDeps({ 'shop.example.test': ['203.0.113.10'] }, () => Promise.resolve(htmlPage('<p>Bread 2</p>')));

        const text = await fetchWatchedPage('https://shop.example.test/bread', deps);

        expect(text)
            .toBe('Bread 2');
        expect(requested)
            .toEqual([{ url: 'https://shop.example.test/bread', addresses: ['203.0.113.10'] }]);
    });

    it('asks for every checked address, in the order the resolver gave them', async () => {
        const { deps, requested } = createDeps({ 'dual.example.test': ['2606:4700:4700::1111', '93.184.216.34'] }, () => Promise.resolve(htmlPage('<p>Dual</p>')));

        expect(await fetchWatchedPage('https://dual.example.test/', deps))
            .toBe('Dual');
        expect(requested)
            .toEqual([{ url: 'https://dual.example.test/', addresses: ['2606:4700:4700::1111', '93.184.216.34'] }]);
    });

    it('returns a plain text page line by line, without stripping tags', async () => {
        const { deps } = createDeps({ 'notes.example.test': ['203.0.113.11'] }, () => Promise.resolve({
            status: 200,
            contentType: 'text/plain',
            body: 'first <b>line</b>\r\n\r\nsecond',
            tooLarge: false,
        }));

        expect(await fetchWatchedPage('http://notes.example.test/', deps))
            .toBe('first <b>line</b>\nsecond');
    });

    it('refuses a host that resolves to a private address, and does not connect', async () => {
        const { deps, requested } = createDeps({ 'internal.example.test': ['10.0.0.5'] }, () => Promise.resolve(htmlPage('x')));

        await expect(fetchWatchedPage('https://internal.example.test/', deps))
            .rejects
            .toThrow('private or reserved address');
        expect(requested)
            .toEqual([]);
    });

    it('refuses a host when any of its addresses is private', async () => {
        const { deps, requested } = createDeps({ 'mixed.example.test': ['203.0.113.10', '127.0.0.1'] }, () => Promise.resolve(htmlPage('x')));

        await expect(fetchWatchedPage('https://mixed.example.test/', deps))
            .rejects
            .toThrow('private or reserved address');
        expect(requested)
            .toEqual([]);
    });

    it('refuses the server own address', async () => {
        const { deps, requested } = createDeps({ 'self.example.test': ['198.51.100.9'] }, () => Promise.resolve(htmlPage('x')));

        await expect(fetchWatchedPage('https://self.example.test/', deps))
            .rejects
            .toThrow('private or reserved address');
        expect(requested)
            .toEqual([]);
    });

    it('refuses a redirect to a private address, and checks the new host too', async () => {
        const { deps, requested } = createDeps({ 'shop.example.test': ['203.0.113.10'], 'admin.internal.test': ['192.168.1.1'] }, () => Promise.resolve({
            status: 302,
            location: 'http://admin.internal.test/secret',
            contentType: 'text/html',
            tooLarge: false,
        }));

        await expect(fetchWatchedPage('https://shop.example.test/', deps))
            .rejects
            .toThrow('private or reserved address');
        expect(requested)
            .toEqual([{ url: 'https://shop.example.test/', addresses: ['203.0.113.10'] }]);
    });

    it('follows up to three redirects and refuses the fourth', async () => {
        const hops: Record<string, string> = {
            'https://one.example.test/': 'https://two.example.test/',
            'https://two.example.test/': 'https://three.example.test/',
            'https://three.example.test/': 'https://four.example.test/',
            'https://four.example.test/': 'https://five.example.test/',
        };
        const addresses = { 'one.example.test': ['203.0.113.1'], 'two.example.test': ['203.0.113.2'], 'three.example.test': ['203.0.113.3'], 'four.example.test': ['203.0.113.4'], 'five.example.test': ['203.0.113.5'] };
        const { deps, requested } = createDeps(addresses, (url) => {
            const next = hops[url.href];

            return Promise.resolve(next === undefined ? htmlPage('<p>End</p>') : { status: 301, location: next, contentType: 'text/html', tooLarge: false });
        });

        await expect(fetchWatchedPage('https://one.example.test/', deps))
            .rejects
            .toThrow('more than 3 times');
        expect(requested)
            .toHaveLength(4);
    });

    it('returns the page after two redirects to public addresses', async () => {
        const { deps } = createDeps({ 'a.example.test': ['203.0.113.1'], 'b.example.test': ['203.0.113.2'] }, (url) => {
            if (url.hostname === 'a.example.test') {
                return Promise.resolve({ status: 301, location: 'https://b.example.test/next', contentType: 'text/html', tooLarge: false });
            }

            return Promise.resolve(htmlPage('<p>Arrived</p>'));
        });

        expect(await fetchWatchedPage('https://a.example.test/', deps))
            .toBe('Arrived');
    });

    it('reports a failed request without the address', async () => {
        const { deps } = createDeps({ 'down.example.test': ['203.0.113.20'] }, () => Promise.reject(new Error('socket hang up')));

        await expect(fetchWatchedPage('https://down.example.test/', deps))
            .rejects
            .toThrow('The page could not be fetched.');
    });

    it('refuses a page that does not answer 200', async () => {
        const { deps } = createDeps({ 'gone.example.test': ['203.0.113.21'] }, () => Promise.resolve({ status: 404, contentType: 'text/html', tooLarge: false }));

        await expect(fetchWatchedPage('https://gone.example.test/', deps))
            .rejects
            .toThrow('status 404');
    });

    it('refuses a page that is not HTML or plain text', async () => {
        const { deps } = createDeps({ 'image.example.test': ['203.0.113.22'] }, () => Promise.resolve({ status: 200, contentType: 'image/png', tooLarge: false }));

        await expect(fetchWatchedPage('https://image.example.test/', deps))
            .rejects
            .toThrow('Only HTML and plain text');
    });

    it('refuses a page over the size limit', async () => {
        const { deps } = createDeps({ 'big.example.test': ['203.0.113.23'] }, () => Promise.resolve({ status: 200, contentType: 'text/html', tooLarge: true }));

        await expect(fetchWatchedPage('https://big.example.test/', deps))
            .rejects
            .toThrow('larger than 1 MB');
    });

    it('refuses a scheme other than http and https before resolving anything', async () => {
        const { deps, requested } = createDeps({}, () => Promise.resolve(htmlPage('x')));

        await expect(fetchWatchedPage('file:///etc/passwd', deps))
            .rejects
            .toThrow('Only http and https');
        await expect(fetchWatchedPage('ftp://example.test/', deps))
            .rejects
            .toThrow('Only http and https');
        expect(requested)
            .toEqual([]);
    });

    it('refuses text that is not a URL', async () => {
        const { deps } = createDeps({}, () => Promise.resolve(htmlPage('x')));

        await expect(fetchWatchedPage('not a url', deps))
            .rejects
            .toThrow('not a valid URL');
    });
});

describe('checkWatchUrl', () => {
    it('returns the problem for a private address and nothing for a public one', async () => {
        const { deps, requested } = createDeps({ 'local.example.test': ['127.0.0.1'], 'shop.example.test': ['203.0.113.10'] }, () => Promise.resolve(htmlPage('x')));

        expect(await checkWatchUrl('http://local.example.test/', deps))
            .toContain('private or reserved address');
        expect(await checkWatchUrl('https://shop.example.test/', deps))
            .toBeUndefined();
        expect(requested)
            .toEqual([]);
    });

    it('gives up after the time budget when the resolver never answers', async () => {
        vi.useFakeTimers();

        try {
            const deps: PageFetchDeps = {
                resolve: () => new Promise<string[]>(() => undefined),
                request: () => Promise.reject(new Error('not reached')),
                localAddresses: [],
            };
            const check = checkWatchUrl('https://slow.example.test/', deps);

            await vi.advanceTimersByTimeAsync(15 * 1000);

            expect(await check)
                .toBe('The page took too long.');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('createPinnedLookup', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('answers with every checked address when the socket asks for all of them', () => {
        const lookup = createPinnedLookup(['2606:4700:4700::1111', '93.184.216.34']);
        const callback = vi.fn();

        lookup('shop.example.test', { all: true }, callback);

        expect(callback)
            .toHaveBeenCalledWith(null, [{ address: '2606:4700:4700::1111', family: 6 }, { address: '93.184.216.34', family: 4 }]);
    });

    it('answers with the first checked address when the socket asks for one', () => {
        const lookup = createPinnedLookup(['93.184.216.34', '2606:4700:4700::1111']);
        const callback = vi.fn();

        lookup('shop.example.test', {}, callback);

        expect(callback)
            .toHaveBeenCalledWith(null, '93.184.216.34', 4);
    });
});
