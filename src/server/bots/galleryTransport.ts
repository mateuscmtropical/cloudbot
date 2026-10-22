import { lookup } from 'node:dns/promises';
import { Readable } from 'node:stream';

import { pinnedFetch } from '../apps/pinnedFetch.ts';
import { BodyTooLargeError, readCapped } from '../apps/readCapped.ts';
import { isPublicAddress, readLocalAddresses } from '../watches/publicAddress.ts';
import { GalleryError } from './templateGallery.ts';
import type { GalleryRequest, GalleryResponse, GalleryTransport } from './templateGallery.ts';

const GALLERY_HOST = 'api.github.com';
const API_VERSION = '2022-11-28';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MIN_REDIRECT_STATUS = 300;
const MAX_REDIRECT_STATUS = 399;
const UNCHECKED_ADDRESS_MESSAGE = 'The gallery address could not be checked, so nothing was read.';
const REDIRECT_MESSAGE = 'GitHub tried to redirect a gallery request, so it was not followed.';
const TOO_LARGE_MESSAGE = 'A gallery answer is larger than 1 MB, so it was not read.';

interface GalleryTransportDeps {
    // Every address the host name resolves to.
    resolve: (hostname: string) => Promise<string[]>;
    // One request over the checked addresses only. Redirects are not followed.
    send: (url: URL, init: RequestInit, addresses: string[]) => Promise<Response>;
    // Addresses of this machine. A name that resolves to one of them is refused.
    localAddresses: string[];
}

function isRedirect(status: number): boolean {
    return status >= MIN_REDIRECT_STATUS && status <= MAX_REDIRECT_STATUS;
}

// Only a public address can be reached. Every address the name has must be public, as for page watches.
async function checkedAddresses(hostname: string, deps: GalleryTransportDeps): Promise<string[]> {
    let addresses: string[];

    try {
        addresses = await deps.resolve(hostname);
    } catch {
        throw new GalleryError(UNCHECKED_ADDRESS_MESSAGE);
    }

    const isEveryPublic = addresses.length > 0 && addresses.every(address => isPublicAddress(address, deps.localAddresses));

    if (!isEveryPublic) {
        throw new GalleryError(UNCHECKED_ADDRESS_MESSAGE);
    }

    return addresses;
}

function buildHeaders(request: GalleryRequest): Record<string, string> {
    const headers: Record<string, string> = {
        'Accept': request.accept,
        'User-Agent': 'CloudBot template gallery',
        'X-GitHub-Api-Version': API_VERSION,
    };

    if (request.token !== undefined) {
        headers.Authorization = `Bearer ${request.token}`;
    }

    if (request.body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }

    return headers;
}

// Reads the answer in full, up to the cap. Text only, since every gallery answer is JSON or a template.
async function readAnswer(response: Response): Promise<string> {
    if (response.body === null) {
        return '';
    }

    const source = Readable.fromWeb(response.body);

    try {
        const bytes = await readCapped(source, MAX_RESPONSE_BYTES);

        return bytes.toString('utf8');
    } catch (error: unknown) {
        if (error instanceof BodyTooLargeError) {
            throw new GalleryError(TOO_LARGE_MESSAGE);
        }

        throw error;
    }
}

// The one network path of the gallery. Only https to api.github.com, only public addresses, and no redirects.
function createGalleryTransport(deps: GalleryTransportDeps): GalleryTransport {
    return async (request: GalleryRequest): Promise<GalleryResponse> => {
        if (request.url.protocol !== 'https:' || request.url.hostname !== GALLERY_HOST) {
            throw new GalleryError(UNCHECKED_ADDRESS_MESSAGE);
        }

        const addresses = await checkedAddresses(request.url.hostname, deps);
        const init: RequestInit = request.body === undefined
            ? { method: request.method, headers: buildHeaders(request) }
            : { method: request.method, headers: buildHeaders(request), body: request.body };
        const response = await deps.send(request.url, init, addresses);

        if (isRedirect(response.status)) {
            await response.body?.cancel();
            throw new GalleryError(REDIRECT_MESSAGE);
        }

        const text = await readAnswer(response);

        return { status: response.status, text };
    };
}

// The live transport. It resolves the host, checks every address, and sends one request to those addresses.
function createDefaultGalleryTransport(): GalleryTransport {
    const deps: GalleryTransportDeps = {
        resolve: async (hostname: string): Promise<string[]> => {
            const entries = await lookup(hostname, { all: true });

            return entries.map(entry => entry.address);
        },
        send: (url, init, addresses) => pinnedFetch(url, init, addresses),
        localAddresses: readLocalAddresses(),
    };

    return createGalleryTransport(deps);
}

export { GALLERY_HOST, createDefaultGalleryTransport, createGalleryTransport };
export type { GalleryTransportDeps };
