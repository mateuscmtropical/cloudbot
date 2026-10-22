import { lookup } from 'node:dns/promises';

import { pinnedFetch } from '../apps/pinnedFetch.ts';
import { isPublicAddress, readLocalAddresses } from '../watches/publicAddress.ts';
import { parsePushEndpoint } from './pushEndpoint.ts';

// One request to a push service. The body is already encrypted.
interface PushRequest {
    endpoint: string;
    headers: Record<string, string>;
    body: Buffer;
}

// The network parts, replaced in tests so no test reaches the network.
interface PushSendDeps {
    resolve: (hostname: string) => Promise<string[]>;
    request: (url: URL, init: RequestInit, addresses: string[]) => Promise<Response>;
    localAddresses: string[];
}

// Sends the request and returns the status the push service answered. It throws when the endpoint is not a known push
// service, when its name resolves to a private address, or when the service cannot be reached.
type PushSender = (request: PushRequest) => Promise<number>;

class PushSendError extends Error {}

const SEND_TIMEOUT_MS = 15 * 1000;

function defaultPushSendDeps(): PushSendDeps {
    return {
        resolve: async (hostname) => {
            const entries = await lookup(hostname, { all: true });

            return entries.map(entry => entry.address);
        },
        request: pinnedFetch,
        localAddresses: readLocalAddresses(),
    };
}

// The endpoint is checked twice. The allowlist keeps the request on a push service, and the address check keeps it off
// private ranges even if a name were bent. The request connects to the checked address only, with no second lookup.
function createPushSender(deps: PushSendDeps = defaultPushSendDeps()): PushSender {
    return async (pushRequest) => {
        const url = parsePushEndpoint(pushRequest.endpoint);

        if (url === undefined) {
            throw new PushSendError('The endpoint is not a known push service.');
        }

        const addresses = await deps.resolve(url.hostname)
            .catch(() => {
                throw new PushSendError('The push service address could not be found.');
            });
        const isAllPublic = addresses.length > 0 && addresses.every(address => isPublicAddress(address, deps.localAddresses));

        if (!isAllPublic) {
            throw new PushSendError('The push service is on a private or reserved address.');
        }

        const init: RequestInit = {
            method: 'POST',
            headers: pushRequest.headers,
            body: new Uint8Array(pushRequest.body),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        };
        const response = await deps.request(url, init, addresses);

        // The answer has nothing the server needs, so its body is dropped.
        await response.body?.cancel();

        return response.status;
    };
}

export { PushSendError, createPushSender };
export type { PushRequest, PushSendDeps, PushSender };
