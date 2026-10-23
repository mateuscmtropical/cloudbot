import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import type { RenderedPage } from '../pages/renderPage.ts';
import { renderNotAvailablePage } from '../pages/renderPages.ts';
import type { LoginSessions } from './LoginSessions.ts';
import { HUB_SESSION_COOKIE } from './sessionCookie.ts';

interface SessionState {
    token: string;
    name: string;
}

interface SessionCookieOptions {
    httpOnly: true;
    secure: boolean;
    sameSite: 'Strict';
    path: '/';
    maxAge: number;
}

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function readRequestHost(context: Context): string | undefined {
    const hostHeader = context.req.header('host');

    if (hostHeader !== undefined) {
        return hostHeader;
    }

    try {
        const requestUrl = new URL(context.req.url);

        return requestUrl.host;
    } catch {
        return undefined;
    }
}

function requestHasSameOrigin(context: Context, secure: boolean): boolean {
    const fetchSite = context.req.header('sec-fetch-site');
    const origin = context.req.header('origin');

    if (fetchSite !== undefined && fetchSite !== 'same-origin') {
        return false;
    }

    // A page with Referrer-Policy no-referrer makes the browser send Origin null on a form post. Sec-Fetch-Site is set by the browser, so a page cannot forge it.
    if (origin === undefined || origin === 'null') {
        return fetchSite === 'same-origin';
    }

    const host = readRequestHost(context);

    if (host === undefined) {
        return false;
    }

    try {
        const originUrl = new URL(origin);
        const expectedOrigin = `${secure ? 'https' : 'http'}://${host.toLowerCase()}`;

        return originUrl.origin === expectedOrigin;
    } catch {
        return false;
    }
}

function readHubSession(context: Context, sessions: LoginSessions, now: number): SessionState | undefined {
    const token = getCookie(context, HUB_SESSION_COOKIE);

    if (token === undefined || token === '') {
        return undefined;
    }

    const name = sessions.find(token, now);

    return name === undefined ? undefined : { token, name };
}

function readContextCookie(context: Context, name: string): string | undefined {
    return getCookie(context, name);
}

function sessionCookieOptions(secure: boolean, maxAge = SESSION_MAX_AGE_SECONDS): SessionCookieOptions {
    return { httpOnly: true, secure, sameSite: 'Strict', path: '/', maxAge };
}

function startHubSession(context: Context, sessions: LoginSessions, name: string, secure: boolean, now: number): string {
    const token = sessions.create(name, now);
    const cookieOptions = sessionCookieOptions(secure);

    setCookie(context, HUB_SESSION_COOKIE, token, cookieOptions);

    return token;
}

function clearHubSessionCookie(context: Context, secure: boolean): void {
    const cookieOptions = sessionCookieOptions(secure, 0);

    setCookie(context, HUB_SESSION_COOKIE, '', cookieOptions);
}

function renderResponse(context: Context, page: RenderedPage, status: 200 | 401 | 404 | 502 = 200): Response {
    context.header('Content-Security-Policy', page.csp);
    context.header('X-Frame-Options', 'DENY');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Cache-Control', 'no-store');

    return context.html(page.html, status);
}

function renderUnavailable(context: Context): Response {
    const page = renderNotAvailablePage();

    return renderResponse(context, page, 404);
}

export {
    clearHubSessionCookie,
    readHubSession,
    readContextCookie,
    readRequestHost,
    renderResponse,
    renderUnavailable,
    requestHasSameOrigin,
    sessionCookieOptions,
    startHubSession,
};
export type { SessionState };
