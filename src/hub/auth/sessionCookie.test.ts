import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import { hubSessionCookieName, readHubSessionCookie, removeHubSessionCookies } from './sessionCookie.ts';

interface CookieHeaderRequest {
    headers: IncomingHttpHeaders;
}

function readCookie(cookieHeader: string | undefined, secure = false): string | undefined {
    const headers: IncomingHttpHeaders = cookieHeader === undefined ? {} : { cookie: cookieHeader };
    const request: CookieHeaderRequest = { headers };
    const incomingRequest = request as unknown as IncomingMessage;
    const token = readHubSessionCookie(incomingRequest, secure);

    return token;
}

describe('readHubSessionCookie', () => {
    it('reads only the hub session cookie', () => {
        expect(readCookie('theme=dark; cloudbot_hub_session=token-value; other=value'))
            .toBe('token-value');
    });

    it('returns undefined when the hub session cookie is missing', () => {
        expect(readCookie('cloudbot_session=instance-cookie'))
            .toBeUndefined();
        expect(readCookie(undefined))
            .toBeUndefined();
    });

    it('over HTTPS reads only the __Host- name, so a cookie planted by a subdomain is ignored', () => {
        expect(hubSessionCookieName(true))
            .toBe('__Host-cloudbot_hub_session');
        expect(readCookie('cloudbot_hub_session=planted', true))
            .toBeUndefined();
        expect(readCookie('cloudbot_hub_session=planted; __Host-cloudbot_hub_session=real', true))
            .toBe('real');
    });
});

describe('removeHubSessionCookies', () => {
    it('drops both names and keeps the other cookies', () => {
        expect(removeHubSessionCookies('a=1; cloudbot_hub_session=x; __Host-cloudbot_hub_session=y; b=2'))
            .toBe('a=1; b=2');
        expect(removeHubSessionCookies('__Host-cloudbot_hub_session=y'))
            .toBeUndefined();
    });
});

export {};
