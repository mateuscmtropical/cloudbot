import type { Context, MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

// Only a plain host name, an IP address and a port can go into the policy. Anything else is left out.
const SAFE_HOST_PATTERN = /^[\w.:[\]-]+$/;

// The built web app loads only its own files. React sets styles through the style object, which the policy allows.
// The screen panel draws frames from data: images, and the tab icon is a data: svg.
const CONTENT_SECURITY_POLICY = {
    defaultSrc: ['\'self\''],
    scriptSrc: ['\'self\''],
    styleSrc: ['\'self\''],
    imgSrc: ['\'self\'', 'data:'],
    fontSrc: ['\'self\''],
    objectSrc: ['\'none\''],
    baseUri: ['\'none\''],
    formAction: ['\'self\''],
    frameAncestors: ['\'none\''],
};

// Older Safari does not match 'self' to a WebSocket on the same host, so the live screen needs it spelled out.
// The host comes from the request. Behind a proxy the scheme the server sees may differ, so both are listed.
function socketSources(host: string | undefined): string {
    return host === undefined || !SAFE_HOST_PATTERN.test(host) ? '' : `ws://${host} wss://${host}`;
}

function readRequestHost(context: Context): string | undefined {
    try {
        return new URL(context.req.url).host;
    } catch {
        return undefined;
    }
}

// HSTS stays with the proxy in front of the server, because a plain http localhost run should not pin the browser.
// publicHost is the host of CLOUDBOT_PUBLIC_URL, which a proxy may send in place of the page's own host.
function createSecurityHeaders(publicHost?: string): MiddlewareHandler {
    const publicSockets = socketSources(publicHost);

    return secureHeaders({
        contentSecurityPolicy: {
            ...CONTENT_SECURITY_POLICY,
            connectSrc: [
                '\'self\'',
                (context) => {
                    const requestHost = readRequestHost(context);

                    return socketSources(requestHost);
                },
                () => publicSockets,
            ],
        },
        xFrameOptions: 'DENY',
        referrerPolicy: 'no-referrer',
        strictTransportSecurity: false,
    });
}

export { CONTENT_SECURITY_POLICY, createSecurityHeaders };
