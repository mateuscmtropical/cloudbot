import type { IncomingMessage } from 'node:http';

const HUB_SESSION_COOKIE = 'cloudbot_hub_session';

function readHubSessionCookie(request: IncomingMessage): string | undefined {
    const cookieHeader = request.headers.cookie ?? '';
    const entries = cookieHeader.split(';')
        .map(entry => entry.trim());
    const prefix = `${HUB_SESSION_COOKIE}=`;
    const sessionEntry = entries.find(entry => entry.startsWith(prefix));

    return sessionEntry?.slice(prefix.length);
}

export { HUB_SESSION_COOKIE, readHubSessionCookie };
