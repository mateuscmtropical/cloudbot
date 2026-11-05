import type { IncomingMessage } from 'node:http';

const PLAIN_HUB_SESSION_COOKIE = 'cloudbot_hub_session';
// Over HTTPS the name starts with __Host-, so the browser takes it only from this exact host, over HTTPS and without a
// Domain. A page on another subdomain cannot plant a session in it.
const SECURE_HUB_SESSION_COOKIE = '__Host-cloudbot_hub_session';

function hubSessionCookieName(secure: boolean): string {
    return secure ? SECURE_HUB_SESSION_COOKIE : PLAIN_HUB_SESSION_COOKIE;
}

function splitCookies(cookieHeader: string | undefined): string[] {
    const entries = (cookieHeader ?? '').split(';');

    return entries.map(entry => entry.trim())
        .filter(entry => entry !== '');
}

function readHubSessionCookie(request: IncomingMessage, secure: boolean): string | undefined {
    const cookieName = hubSessionCookieName(secure);
    const prefix = `${cookieName}=`;
    const entries = splitCookies(request.headers.cookie);
    const sessionEntry = entries.find(entry => entry.startsWith(prefix));

    return sessionEntry?.slice(prefix.length);
}

function isHubSessionEntry(entry: string): boolean {
    return entry.startsWith(`${PLAIN_HUB_SESSION_COOKIE}=`) || entry.startsWith(`${SECURE_HUB_SESSION_COOKIE}=`);
}

// The instance never gets the hub session, under either name.
function removeHubSessionCookies(cookieHeader: string | undefined): string | undefined {
    const entries = splitCookies(cookieHeader);
    const keptCookies = entries.filter(entry => !isHubSessionEntry(entry));

    return keptCookies.length === 0 ? undefined : keptCookies.join('; ');
}

export { hubSessionCookieName, readHubSessionCookie, removeHubSessionCookies };
