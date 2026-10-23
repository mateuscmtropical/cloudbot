import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import { HUB_SESSION_COOKIE, readHubSessionCookie } from './sessionCookie.ts';

interface CookieHeaderRequest {
    headers: IncomingHttpHeaders;
}

function readCookie(cookieHeader: string | undefined): string | undefined {
    const headers: IncomingHttpHeaders = cookieHeader === undefined ? {} : { cookie: cookieHeader };
    const request: CookieHeaderRequest = { headers };
    const incomingRequest = request as unknown as IncomingMessage;
    const token = readHubSessionCookie(incomingRequest);

    return token;
}

describe('readHubSessionCookie', () => {
    it('reads only the hub session cookie', () => {
        expect(readCookie(`theme=dark; ${HUB_SESSION_COOKIE}=token-value; other=value`))
            .toBe('token-value');
    });

    it('returns undefined when the hub session cookie is missing', () => {
        expect(readCookie('cloudbot_session=instance-cookie'))
            .toBeUndefined();
        expect(readCookie(undefined))
            .toBeUndefined();
    });
});

export {};
