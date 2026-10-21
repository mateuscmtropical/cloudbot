import { isIP } from 'node:net';

// A host name or IP address in one form, so the allow list and the gate compare the same text.
// Names are lowercase without a trailing dot. IPv6 addresses are written the short way.
// Undefined when the text is not a bare host, such as an address with a path or a second colon.
function normalizeHost(text: string): string | undefined {
    const trimmed = text.trim()
        .toLowerCase();
    const bare = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;

    if (bare === '' || /[/?#@\s[\]]/.test(bare)) {
        return undefined;
    }

    const isIpv6 = bare.includes(':');

    if (isIpv6 && isIP(bare) !== 6) {
        return undefined;
    }

    const wrapped = isIpv6 ? `[${bare}]` : bare;

    try {
        const hostname = new URL(`http://${wrapped}`).hostname
            .replace(/^\[|\]$/g, '')
            .replace(/\.$/, '');

        return hostname === '' ? undefined : hostname;
    } catch {
        return undefined;
    }
}

export { normalizeHost };
