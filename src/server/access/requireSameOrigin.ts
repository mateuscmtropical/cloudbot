import type { Context, MiddlewareHandler } from 'hono';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UPLOAD_PATH_PATTERN = /^\/api\/bots\/[^/]+\/attachments$/;
const JSON_MEDIA_TYPE = 'application/json';
const MULTIPART_MEDIA_TYPE = 'multipart/form-data';
const SAME_ORIGIN = 'same-origin';

interface RequestRefusal {
    error: string;
}

const WRONG_ORIGIN: RequestRefusal = { error: 'This request did not come from the CloudBot page.' };

interface SameOriginOptions {
    // The host of CLOUDBOT_PUBLIC_URL. The owner may open the page on that address behind a proxy.
    publicHost?: string | undefined;
}

// The host of the public address, when one is set and valid.
function readPublicHost(publicUrl: string | undefined): string | undefined {
    if (publicUrl === undefined || publicUrl === '') {
        return undefined;
    }

    try {
        return new URL(publicUrl).host.toLowerCase();
    } catch {
        return undefined;
    }
}

function readHost(address: string): string | undefined {
    try {
        return new URL(address).host.toLowerCase();
    } catch {
        return undefined;
    }
}

// The cookie does not tell localhost ports apart, so the Origin must name this server's own host.
// A request without an Origin passes only when the browser says it is a same-origin fetch.
function isOwnRequest(context: Context, options: SameOriginOptions): boolean {
    const fetchSite = context.req.header('sec-fetch-site');
    const origin = context.req.header('origin');

    if (fetchSite !== undefined && fetchSite !== SAME_ORIGIN) {
        return false;
    }

    if (origin === undefined) {
        return fetchSite === SAME_ORIGIN;
    }

    const originHost = readHost(origin);
    const ownHost = readHost(context.req.url);

    return originHost !== undefined && (originHost === ownHost || originHost === options.publicHost);
}

// A body without a length header can only come from a chunked request, so it counts as a body too.
function hasBody(context: Context): boolean {
    const contentLength = context.req.header('content-length');
    const transferEncoding = context.req.header('transfer-encoding');

    return transferEncoding !== undefined || (contentLength !== undefined && contentLength !== '0');
}

function readMediaType(context: Context): string {
    const contentType = context.req.header('content-type') ?? '';
    const [mediaType = ''] = contentType.split(';');

    return mediaType.trim()
        .toLowerCase();
}

function expectedMediaType(path: string): string {
    return UPLOAD_PATH_PATTERN.test(path) ? MULTIPART_MEDIA_TYPE : JSON_MEDIA_TYPE;
}

// Another site or another local port can send a form post with the cookie. This refuses it before any route runs.
function requireSameOrigin(options: SameOriginOptions = {}): MiddlewareHandler {
    return async (context, next) => {
        if (!STATE_CHANGING_METHODS.has(context.req.method)) {
            await next();

            return;
        }

        if (!isOwnRequest(context, options)) {
            return context.json(WRONG_ORIGIN, 403);
        }

        const expected = expectedMediaType(context.req.path);

        if (hasBody(context) && readMediaType(context) !== expected) {
            const wrongType: RequestRefusal = { error: `Send the body as ${expected}.` };

            return context.json(wrongType, 415);
        }

        await next();
    };
}

export { readPublicHost, requireSameOrigin };
export type { SameOriginOptions };
