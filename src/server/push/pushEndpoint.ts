// A push endpoint is an address the browser chose, and the server sends a request to it. So only the push services of the
// browsers are accepted, never any other address. Each entry matches the host itself and its subdomains.
//
// Google (Chrome, Edge, Opera, Samsung Internet), Mozilla (Firefox), Apple (Safari) and Windows (Edge on Windows).
const PUSH_SERVICE_DOMAINS = [
    'fcm.googleapis.com',
    'push.services.mozilla.com',
    'push.apple.com',
    'notify.windows.com',
];

const MAX_ENDPOINT_LENGTH = 2048;
const HTTPS_PORT = '';

function isPushServiceHost(hostname: string): boolean {
    return PUSH_SERVICE_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

// Returns the address when it is an https address of a known push service, with no port, no user name and no password.
// Anything else returns undefined. The URL parser lowercases the host and refuses odd forms, so a trick such as
// "fcm.googleapis.com.evil.test" or "evil.test/fcm.googleapis.com" does not pass.
function parsePushEndpoint(text: string): URL | undefined {
    if (text.length > MAX_ENDPOINT_LENGTH) {
        return undefined;
    }

    let url: URL;

    try {
        url = new URL(text);
    } catch {
        return undefined;
    }

    const isPlainHttps = url.protocol === 'https:' && url.port === HTTPS_PORT && url.username === '' && url.password === '';

    return isPlainHttps && isPushServiceHost(url.hostname) ? url : undefined;
}

export { PUSH_SERVICE_DOMAINS, parsePushEndpoint };
