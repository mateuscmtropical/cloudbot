import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

import { pinnedFetch } from '../apps/pinnedFetch.ts';
import { BodyTooLargeError, readCapped } from '../apps/readCapped.ts';
import { isPublicAddress, readLocalAddresses } from '../watches/publicAddress.ts';

interface OutgoingWebhook {
    url: string;
    method?: string | undefined;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
}

interface OutgoingAnswer {
    status: number;
    text: string;
}

// The network parts. Tests replace them, so no test reaches the network.
interface OutgoingWebhookDeps {
    resolve: (hostname: string) => Promise<string[]>;
    send: (url: URL, init: RequestInit, addresses: string[]) => Promise<Response>;
    localAddresses: string[];
}

type SendOutgoingWebhook = (webhook: OutgoingWebhook) => Promise<OutgoingAnswer>;

// The message goes to the model and names no address of this machine.
class OutgoingWebhookError extends Error {}

const MAX_URL_LENGTH = 2048;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ANSWER_BYTES = 256 * 1024;
const MAX_ANSWER_CHARACTERS = 4000;
const TIMEOUT_MS = 30 * 1000;
const NOT_ALLOWED_MESSAGE = 'That address is private or reserved, or could not be found, so nothing was sent.';
// The connection sets these itself. A different Host would also send the request to another site on the same server.
const FIXED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

function parseUrl(text: string): URL {
    let url: URL;

    try {
        url = new URL(text);
    } catch {
        throw new OutgoingWebhookError('That is not a valid address. Use a full https address.');
    }

    if (text.length > MAX_URL_LENGTH || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
        throw new OutgoingWebhookError('Use an http or https address of at most 2048 characters.');
    }

    return url;
}

async function resolveOrNone(hostname: string, deps: OutgoingWebhookDeps): Promise<string[]> {
    try {
        return await deps.resolve(hostname);
    } catch {
        return [];
    }
}

async function checkedAddresses(url: URL, deps: OutgoingWebhookDeps): Promise<string[]> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const isName = isIP(hostname) === 0;
    const addresses = isName ? await resolveOrNone(hostname, deps) : [hostname];
    const isEveryPublic = addresses.length > 0 && addresses.every(address => isPublicAddress(address, deps.localAddresses));

    if (!isEveryPublic) {
        throw new OutgoingWebhookError(NOT_ALLOWED_MESSAGE);
    }

    return addresses;
}

function buildHeaders(webhook: OutgoingWebhook): Record<string, string> {
    const entries = Object.entries(webhook.headers ?? {});
    const kept = entries.filter(([name]) => {
        const lowerName = name.toLowerCase();

        return !FIXED_HEADERS.has(lowerName);
    });
    const keptHeaders = Object.fromEntries(kept);
    const headers: Record<string, string> = { 'user-agent': 'CloudBot webhook', ...keptHeaders };
    const hasContentType = kept.some(([name]) => name.toLowerCase() === 'content-type');

    if (webhook.body !== undefined && !hasContentType) {
        headers['content-type'] = 'application/json';
    }

    return headers;
}

async function readAnswer(response: Response): Promise<string> {
    if (response.body === null) {
        return '';
    }

    const source = Readable.fromWeb(response.body);

    try {
        const bytes = await readCapped(source, MAX_ANSWER_BYTES);
        const text = bytes.toString('utf8');

        return text.slice(0, MAX_ANSWER_CHARACTERS);
    } catch (error: unknown) {
        if (error instanceof BodyTooLargeError) {
            return '';
        }

        throw error;
    }
}

// One request to a public address, pinned to the addresses that were checked. Redirects are not followed, so a server cannot
// send the request on to a private host.
function createOutgoingWebhookSender(deps: OutgoingWebhookDeps): SendOutgoingWebhook {
    return async (webhook) => {
        const url = parseUrl(webhook.url);

        if (Buffer.byteLength(webhook.body ?? '') > MAX_BODY_BYTES) {
            throw new OutgoingWebhookError('The body is larger than 64 KB, so nothing was sent.');
        }

        const addresses = await checkedAddresses(url, deps);
        const headers = buildHeaders(webhook);
        const signal = AbortSignal.timeout(TIMEOUT_MS);
        const init: RequestInit = { method: webhook.method ?? 'POST', headers, signal, ...(webhook.body === undefined ? {} : { body: webhook.body }) };
        const response = await deps.send(url, init, addresses);
        const text = await readAnswer(response);

        return { status: response.status, text };
    };
}

function createDefaultOutgoingWebhookSender(): SendOutgoingWebhook {
    return createOutgoingWebhookSender({
        resolve: async (hostname) => {
            const entries = await lookup(hostname, { all: true });

            return entries.map(entry => entry.address);
        },
        send: (url, init, addresses) => pinnedFetch(url, init, addresses),
        localAddresses: readLocalAddresses(),
    });
}

export { MAX_ANSWER_CHARACTERS, OutgoingWebhookError, createDefaultOutgoingWebhookSender, createOutgoingWebhookSender };
export type { OutgoingAnswer, OutgoingWebhook, OutgoingWebhookDeps, SendOutgoingWebhook };
