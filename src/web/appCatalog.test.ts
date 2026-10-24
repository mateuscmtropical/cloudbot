import { describe, expect, it } from 'vitest';

import { APP_CATALOG, APP_CATEGORIES } from './appCatalog.ts';

const SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

describe('APP_CATALOG', () => {
    it('gives every app a server name the server accepts', () => {
        APP_CATALOG.forEach((app) => {
            expect(app.serverName)
                .toMatch(SERVER_NAME_PATTERN);
        });
    });

    it('uses every server name and address only once', () => {
        const serverNames = new Set(APP_CATALOG.map(app => app.serverName));
        const urls = new Set(APP_CATALOG.map(app => app.url));

        expect(serverNames.size)
            .toBe(APP_CATALOG.length);
        expect(urls.size)
            .toBe(APP_CATALOG.length);
    });

    it('uses https addresses only', () => {
        APP_CATALOG.forEach((app) => {
            expect(app.url.startsWith('https://'))
                .toBe(true);
        });
    });

    it('puts every app in a listed category and fills every category', () => {
        APP_CATEGORIES.forEach((category) => {
            const appsInCategory = APP_CATALOG.filter(app => app.category === category);

            expect(appsInCategory.length)
                .toBeGreaterThan(0);
        });
        APP_CATALOG.forEach((app) => {
            expect(APP_CATEGORIES)
                .toContain(app.category);
        });
    });
});
