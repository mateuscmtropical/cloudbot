import { request as requestHttp } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as requestHttps } from 'node:https';
import { lookup } from 'node:dns/promises';

import { isPublicAddress, readLocalAddresses } from './publicAddress.ts';
import { htmlToVisibleText, normalizeLines } from './pageText.ts';

// The answer to one request. `body` is undefined unless the page is a text page that was read in full.
interface PageResponse {
    status: number;
    location?: string | undefined;
    contentType: string;
    body?: string | undefined;
    tooLarge: boolean;
}

// The network parts of the fetch. Tests replace them, so no test reaches the network.
interface PageFetchDeps {
    // Every address the host name resolves to.
    resolve: (hostname: string) => Promise<string[]>;
    // One request. The connection uses only the checked addresses, in order, and no second lookup.
    request: (url: URL, addresses: string[]) => Promise<PageResponse>;
    // Addresses of this server. A page on one of them is refused too.
    localAddresses: string[];
}

// The parts of the socket lookup hook that the pinned lookup uses.
interface PinnedLookupOptions {
    all?: boolean | undefined;
}

interface LookupEntry {
    address: string;
    family: number;
}

type PinnedLookupCallback = (error: null, address: string | LookupEntry[], family?: number) => void;

class WatchFetchError extends Error {}

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15 * 1000;
const MAX_PAGE_BYTES = 1024 * 1024;
const TEXT_TYPES = ['text/html', 'text/plain'];

// The lookup hook answers with the checked addresses only, so a second DNS answer cannot change them.
// With `all`, Node tries each address in turn (autoSelectFamily), so an IPv6 address the server cannot reach falls back to IPv4.
function createPinnedLookup(addresses: string[]): (hostname: string, options: PinnedLookupOptions, callback: PinnedLookupCallback) => void {
    const entries: LookupEntry[] = addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));

    return (_hostname, options, callback) => {
        if (options.all === true) {
            callback(null, entries);

            return;
        }

        // checkedAddresses never returns an empty list, so the first entry exists.
        const first = entries[0];

        callback(null, first?.address ?? '', first?.family ?? 4);
    };
}

function requestPage(url: URL, addresses: string[]): Promise<PageResponse> {
    return new Promise((resolve, reject) => {
        const send = url.protocol === 'https:' ? requestHttps : requestHttp;
        const pageRequest = send(url, {
            method: 'GET',
            headers: { 'User-Agent': 'CloudBot page watch', 'Accept': 'text/html, text/plain' },
            lookup: createPinnedLookup(addresses),
        }, (response: IncomingMessage) => {
            const status = response.statusCode ?? 0;
            const contentType = response.headers['content-type'] ?? '';
            const location = response.headers.location;

            if (status !== 200 || !isTextType(contentType)) {
                response.resume();
                resolve({ status, location, contentType, tooLarge: false });

                return;
            }

            const chunks: Buffer[] = [];
            let size = 0;

            response.on('data', (chunk: Buffer) => {
                size += chunk.length;

                if (size > MAX_PAGE_BYTES) {
                    pageRequest.destroy();
                    resolve({ status, location, contentType, tooLarge: true });

                    return;
                }

                chunks.push(chunk);
            });
            response.on('end', () => {
                const body = Buffer.concat(chunks)
                    .toString('utf8');

                resolve({ status, location, contentType, body, tooLarge: false });
            });
            response.on('error', reject);
        });

        const timer = setTimeout(() => {
            pageRequest.destroy(new Error('The page took too long.'));
        }, TIMEOUT_MS);

        pageRequest.on('close', () => {
            clearTimeout(timer);
        });
        pageRequest.on('error', reject);
        pageRequest.end();
    });
}

function defaultDeps(): PageFetchDeps {
    return {
        resolve: async (hostname) => {
            const entries = await lookup(hostname, { all: true });

            return entries.map(entry => entry.address);
        },
        request: requestPage,
        localAddresses: readLocalAddresses(),
    };
}

function isTextType(contentType: string): boolean {
    const mediaType = contentType.split(';')[0]?.trim()
        .toLowerCase() ?? '';

    return TEXT_TYPES.includes(mediaType);
}

// Only http and https URLs are read. Anything else is refused before a name is resolved.
function parseWatchUrl(text: string): URL {
    let url: URL;

    try {
        url = new URL(text);
    } catch {
        throw new WatchFetchError('The address is not a valid URL.');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new WatchFetchError('Only http and https pages can be watched.');
    }

    return url;
}

// Resolves the host and refuses it unless every address it has is public. Returns all of them, in the order the resolver gave.
async function checkedAddresses(url: URL, deps: PageFetchDeps): Promise<string[]> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];

    try {
        addresses = await deps.resolve(hostname);
    } catch {
        throw new WatchFetchError('The address of the page could not be found.');
    }

    if (addresses.length === 0) {
        throw new WatchFetchError('The address of the page could not be found.');
    }

    const isAllPublic = addresses.every(address => isPublicAddress(address, deps.localAddresses));

    if (!isAllPublic) {
        throw new WatchFetchError('That page is on a private or reserved address, so it cannot be watched.');
    }

    return addresses;
}

// Checks the address of a URL without fetching it. Returns the problem as text, or undefined when the URL is fine.
async function checkWatchUrl(text: string, deps: PageFetchDeps = defaultDeps()): Promise<string | undefined> {
    try {
        const url = parseWatchUrl(text);
        const check = checkedAddresses(url, deps);

        await withHopBudget(check);

        return undefined;
    } catch (error: unknown) {
        return error instanceof WatchFetchError ? error.message : 'The page could not be checked.';
    }
}

// The lookup and the request of one hop, as one piece of work. The budget below covers both.
async function lookupAndRequest(url: URL, deps: PageFetchDeps): Promise<PageResponse> {
    const addresses = await checkedAddresses(url, deps);

    return deps.request(url, addresses)
        .catch(() => {
            throw new WatchFetchError('The page could not be fetched.');
        });
}

// A redirect target is read against the page that sent it. A target that is not a URL ends the fetch.
function resolveLocation(location: string, base: URL): string {
    try {
        return new URL(location, base).href;
    } catch {
        throw new WatchFetchError('The page redirects to an address that is not a valid URL.');
    }
}

// One TIMEOUT_MS budget per hop. A resolver or a connection that never answers ends the hop with an error.
async function withHopBudget<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new WatchFetchError('The page took too long.'));
        }, TIMEOUT_MS);
    });

    try {
        return await Promise.race([work, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

// Each hop is checked again, so a redirect to a private address is refused too.
async function fetchHop(text: string, deps: PageFetchDeps, redirectsLeft: number): Promise<string> {
    const url = parseWatchUrl(text);
    const hopWork = lookupAndRequest(url, deps);
    const response = await withHopBudget(hopWork);
    const location = response.location;

    if (response.status >= 300 && response.status < 400) {
        if (location === undefined) {
            throw new WatchFetchError(`The page answered with status ${String(response.status)} and no new address.`);
        }

        if (redirectsLeft === 0) {
            throw new WatchFetchError(`The page redirects more than ${String(MAX_REDIRECTS)} times.`);
        }

        const nextText = resolveLocation(location, url);

        return fetchHop(nextText, deps, redirectsLeft - 1);
    }

    if (response.status !== 200) {
        throw new WatchFetchError(`The page answered with status ${String(response.status)}.`);
    }

    if (!isTextType(response.contentType)) {
        throw new WatchFetchError('Only HTML and plain text pages can be watched.');
    }

    if (response.tooLarge || response.body === undefined) {
        throw new WatchFetchError('The page is larger than 1 MB.');
    }

    return isHtml(response.contentType) ? htmlToVisibleText(response.body) : normalizeLines(response.body);
}

function isHtml(contentType: string): boolean {
    return contentType.toLowerCase()
        .includes('text/html');
}

// Returns the visible text of a page. Errors are WatchFetchError, with a message that names no address.
async function fetchWatchedPage(text: string, deps: PageFetchDeps = defaultDeps()): Promise<string> {
    return fetchHop(text, deps, MAX_REDIRECTS);
}

export { MAX_PAGE_BYTES, MAX_REDIRECTS, WatchFetchError, checkWatchUrl, createPinnedLookup, fetchWatchedPage };
export type { PageFetchDeps, PageResponse };
