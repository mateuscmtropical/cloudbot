import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

import { isAllowablePrivateAddress, isPublicAddress, readLocalAddresses } from '../watches/publicAddress.ts';

// A host the owner allowed the browser to reach. Port 0 means every port of the host.
interface AllowedPrivateHost {
    host: string;
    port: number;
}

// The network parts of the check. Tests replace them, so no test reaches the network.
interface AppAddressDeps {
    // Every address the host name resolves to.
    resolve: (hostname: string) => Promise<string[]>;
    // Addresses of this server. A server on one of them is refused.
    localAddresses: string[];
    // Hosts the owner allowed the browser to reach. Only these may be private, and only for the host and port of the URL.
    allowedHosts: AllowedPrivateHost[];
}

// A checked URL and the addresses it was checked against. The connection uses only those addresses.
interface CheckedAppUrl {
    url: URL;
    addresses: string[];
}

// The message is written for the model and the owner, and names no address of this machine.
class AppAddressError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AppAddressError';
    }
}

const MAX_URL_LENGTH = 2048;
const ANY_PORT = 0;
const PRIVATE_HOST_MESSAGE = 'That address is private or reserved. A private host works only when the owner allowed it for the browser first.';

// Only http and https, with no user name or password in the address.
function parseAppUrl(text: string): URL {
    if (text.length > MAX_URL_LENGTH) {
        throw new AppAddressError('That address is too long.');
    }

    let url: URL;

    try {
        url = new URL(text);
    } catch {
        throw new AppAddressError('That is not a valid address. Use a full http or https address.');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new AppAddressError('Only http and https addresses can be connected.');
    }

    // A token or other secret in the address would reach the model and the logs, so the query and the hash are refused too.
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
        throw new AppAddressError('Put the token in the secure form, not in the address.');
    }

    return url;
}

// Resolves the host, and refuses it unless every address is public, or the host is allowed for the browser.
// The addresses come back with the URL, so the later request can be pinned to them.
async function checkAppUrl(text: string, deps: AppAddressDeps): Promise<CheckedAppUrl> {
    const url = parseAppUrl(text);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const isAllowedHost = deps.allowedHosts.some(allowed => isAllowedFor(allowed, url, hostname));
    const addresses = isIP(hostname) === 0 ? await resolveHost(hostname, deps) : [hostname];

    const isAllowed = addresses.every(address => isPublicAddress(address, deps.localAddresses)
        || (isAllowedHost && isAllowablePrivateAddress(address, deps.localAddresses)));

    if (!isAllowed) {
        throw new AppAddressError(PRIVATE_HOST_MESSAGE);
    }

    return { url, addresses };
}

// The port of a URL, with the default port of its protocol when the URL names none.
function portOf(url: URL): number {
    if (url.port !== '') {
        return Number(url.port);
    }

    return url.protocol === 'https:' ? 443 : 80;
}

function isAllowedFor(allowed: AllowedPrivateHost, url: URL, hostname: string): boolean {
    const isSameHost = allowed.host === hostname;
    const isSamePort = allowed.port === ANY_PORT || allowed.port === portOf(url);

    return isSameHost && isSamePort;
}

async function resolveHost(hostname: string, deps: AppAddressDeps): Promise<string[]> {
    let addresses: string[];

    try {
        addresses = await deps.resolve(hostname);
    } catch {
        throw new AppAddressError('The address of that server could not be found.');
    }

    if (addresses.length === 0) {
        throw new AppAddressError('The address of that server could not be found.');
    }

    return addresses;
}

async function lookupAllAddresses(hostname: string): Promise<string[]> {
    const entries = await lookup(hostname, { all: true });

    return entries.map(entry => entry.address);
}

function defaultAppAddressDeps(allowedHosts: AllowedPrivateHost[]): AppAddressDeps {
    return {
        resolve: lookupAllAddresses,
        localAddresses: readLocalAddresses(),
        allowedHosts,
    };
}

export { AppAddressError, checkAppUrl, defaultAppAddressDeps, parseAppUrl };
export type { AllowedPrivateHost, AppAddressDeps, CheckedAppUrl };
