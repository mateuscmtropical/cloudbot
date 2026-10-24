import { describe, expect, it } from 'vitest';

import { GOOGLE_APPS, findGoogleApp } from './googleApps.ts';

describe('GOOGLE_APPS', () => {
    it('gives every app a valid server name, a Google https address and full scope addresses', () => {
        GOOGLE_APPS.forEach((app) => {
            expect(app.serverName)
                .toMatch(/^google-[a-z]+$/);
            expect(app.url)
                .toMatch(/^https:\/\/[a-z]+mcp\.googleapis\.com\/mcp\/v1$/);
            expect(app.scopes.length)
                .toBeGreaterThan(0);
            app.scopes.forEach((scope) => {
                expect(scope.startsWith('https://www.googleapis.com/auth/'))
                    .toBe(true);
            });
        });
    });

    it('uses every server name and address only once', () => {
        const serverNames = new Set(GOOGLE_APPS.map(app => app.serverName));
        const urls = new Set(GOOGLE_APPS.map(app => app.url));

        expect(serverNames.size)
            .toBe(GOOGLE_APPS.length);
        expect(urls.size)
            .toBe(GOOGLE_APPS.length);
    });

    it('asks Calendar for the scope that can change events', () => {
        const calendar = findGoogleApp('google-calendar', 'https://calendarmcp.googleapis.com/mcp/v1');

        expect(calendar?.scopes)
            .toContain('https://www.googleapis.com/auth/calendar.events');
    });
});

describe('findGoogleApp', () => {
    it('finds an app by its name and address together', () => {
        expect(findGoogleApp('google-gmail', 'https://gmailmcp.googleapis.com/mcp/v1')?.displayName)
            .toBe('Gmail');
    });

    it('does not treat a Google name with another address as Google', () => {
        expect(findGoogleApp('google-gmail', 'https://mcp.example.com/mcp'))
            .toBeUndefined();
    });

    it('does not treat another name at a Google address as Google', () => {
        expect(findGoogleApp('my-mail', 'https://gmailmcp.googleapis.com/mcp/v1'))
            .toBeUndefined();
    });
});

describe('the scopes of each Google card', () => {
    const base = 'https://www.googleapis.com/auth/';
    const expectedScopes: Record<string, string[]> = {
        'google-gmail': ['gmail.readonly', 'gmail.compose'],
        'google-calendar': ['calendar.calendarlist.readonly', 'calendar.events.freebusy', 'calendar.events.readonly', 'calendar.events'],
        'google-drive': ['drive.readonly', 'drive.file'],
        'google-docs': ['drive.readonly', 'drive.file', 'documents.readonly', 'documents'],
        'google-sheets': ['drive.readonly', 'drive.file', 'spreadsheets.readonly', 'spreadsheets'],
    };

    it('lists the five apps in the order of the cards', () => {
        expect(GOOGLE_APPS.map(app => app.serverName))
            .toEqual(Object.keys(expectedScopes));
    });

    it('asks each app only for its own scopes', () => {
        GOOGLE_APPS.forEach((app) => {
            const expected = (expectedScopes[app.serverName] ?? []).map(name => `${base}${name}`);

            expect(app.scopes)
                .toEqual(expected);
        });
    });

    it('does not ask Gmail for Drive or Calendar scopes', () => {
        const gmail = findGoogleApp('google-gmail', 'https://gmailmcp.googleapis.com/mcp/v1');

        expect(gmail?.scopes.some(scope => scope.includes('drive') || scope.includes('calendar')))
            .toBe(false);
    });
});
