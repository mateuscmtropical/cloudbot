import type { BitwardenLoginItem } from './BitwardenCli.ts';

const HTTPS_PROTOCOL = 'https:';
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// A URI of a Bitwarden item is a full address, or only a host such as github.com. Anything with another scheme
// (http, androidapp, a regex) never matches, so a page is never treated as the app of an item.
function parseItemUri(rawUri: string): URL | undefined {
    const trimmed = rawUri.trim();
    const hasScheme = SCHEME_PATTERN.test(trimmed);
    const address = hasScheme ? trimmed : `https://${trimmed}`;

    try {
        const parsed = new URL(address);

        return parsed.protocol === HTTPS_PROTOCOL ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function normalizeHost(hostname: string): string {
    return hostname.replace(/\.$/, '');
}

// Same host, or the page is a subdomain of the item's host. A host with one label ("com") or an IP address
// matches only itself, since a bare suffix would match half of the web.
function isHostMatch(pageHost: string, itemHost: string): boolean {
    if (pageHost === itemHost) {
        return true;
    }

    const isSuffixOnly = !itemHost.includes('.') || IPV4_PATTERN.test(itemHost) || itemHost.startsWith('[');

    return !isSuffixOnly && pageHost.endsWith(`.${itemHost}`);
}

// The page origin comes from the browser itself. Only an https page with the same port as the item can match.
function doesUriMatchPage(rawUri: string, pageOrigin: string): boolean {
    let pageUrl: URL;

    try {
        pageUrl = new URL(pageOrigin);
    } catch {
        return false;
    }

    const itemUrl = parseItemUri(rawUri);

    if (pageUrl.protocol !== HTTPS_PROTOCOL || itemUrl === undefined) {
        return false;
    }

    const isSamePort = pageUrl.port === itemUrl.port;
    const pageHost = normalizeHost(pageUrl.hostname);
    const itemHost = normalizeHost(itemUrl.hostname);

    return isSamePort && isHostMatch(pageHost, itemHost);
}

function matchLoginItems(items: BitwardenLoginItem[], pageOrigin: string): BitwardenLoginItem[] {
    return items.filter(item => item.uris.some(uri => doesUriMatchPage(uri, pageOrigin)));
}

export { doesUriMatchPage, matchLoginItems };
