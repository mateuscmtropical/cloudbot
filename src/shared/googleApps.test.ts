import { describe, expect, it } from 'vitest';

import { GOOGLE_APPS, GOOGLE_GROUP, findGoogleApp, findGoogleGroup } from './googleApps.ts';

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

describe('GOOGLE_GROUP', () => {
    it('lists the five apps as members and asks for each scope once', () => {
        expect(GOOGLE_GROUP.members.map(member => member.serverName))
            .toEqual(['google-gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-sheets']);
        expect(new Set(GOOGLE_GROUP.scopes).size)
            .toBe(GOOGLE_GROUP.scopes.length);
        GOOGLE_APPS.forEach((app) => {
            app.scopes.forEach((scope) => {
                expect(GOOGLE_GROUP.scopes)
                    .toContain(scope);
            });
        });
    });

    it('is found only by its name and its address together', () => {
        expect(findGoogleGroup('google', GOOGLE_GROUP.url))
            .toBe(GOOGLE_GROUP);
        expect(findGoogleGroup('google', 'https://mcp.example.com/mcp'))
            .toBeUndefined();
        expect(findGoogleGroup('my-google', GOOGLE_GROUP.url))
            .toBeUndefined();
    });
});
