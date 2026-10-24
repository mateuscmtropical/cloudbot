import { describe, expect, it } from 'vitest';

import { APP_CATALOG } from './appCatalog.ts';
import { APP_LOGOS, getLogoGlyphColor } from './appLogos.ts';

describe('APP_LOGOS', () => {
    it('only has logos for apps of the catalog', () => {
        const serverNames = APP_CATALOG.map(app => app.serverName);

        Object.keys(APP_LOGOS)
            .forEach((serverName) => {
                expect(serverNames)
                    .toContain(serverName);
            });
    });

    it('has the Bitwarden logo in its brand color', () => {
        expect(APP_LOGOS.bitwarden?.color)
            .toBe('#175DDC');
        expect(APP_LOGOS.bitwarden?.path.startsWith('M21.722.296'))
            .toBe(true);
    });

    it('has a path and a hex color for every logo', () => {
        Object.values(APP_LOGOS)
            .forEach((logo) => {
                expect(logo.path.length)
                    .toBeGreaterThan(0);
                expect(logo.color)
                    .toMatch(/^#[0-9A-F]{6}$/i);
            });
    });
});

describe('getLogoGlyphColor', () => {
    it('keeps dark and mid brand colors', () => {
        expect(getLogoGlyphColor('#000000'))
            .toBe('#000000');
        expect(getLogoGlyphColor('#635BFF'))
            .toBe('#635BFF');
    });

    it('swaps colors that are too light for a white tile', () => {
        expect(getLogoGlyphColor('#FFFFFF'))
            .toBe('#1f1f1f');
        expect(getLogoGlyphColor('#FFEB3B'))
            .toBe('#1f1f1f');
    });
});
