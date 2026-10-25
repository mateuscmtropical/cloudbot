import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ManifestIcon {
    src: string;
    purpose?: string;
}

interface WebManifest {
    start_url: string;
    scope: string;
    display: string;
    icons: ManifestIcon[];
}

const WEB_DIR = join(import.meta.dirname, '..', '..', 'web');
const PUBLIC_DIR = join(WEB_DIR, 'public');
const manifestText = readFileSync(join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8');
const manifest = JSON.parse(manifestText) as WebManifest;
const indexHtml = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
const stylesheet = readFileSync(join(WEB_DIR, 'styles.css'), 'utf8');

describe('the installable web app files', () => {
    it('lists only icons that exist, with a maskable one for Android', () => {
        const missing = manifest.icons.filter(icon => !existsSync(join(PUBLIC_DIR, icon.src)));

        expect(missing)
            .toEqual([]);
        expect(manifest.icons.some(icon => icon.purpose === 'maskable'))
            .toBe(true);
    });

    it('starts as a standalone app at the root of its own address', () => {
        expect([manifest.start_url, manifest.scope, manifest.display])
            .toEqual(['/', '/', 'standalone']);
    });

    // Behind the hub the manifest needs the sign-in cookie, or the browser gets the sign-in page instead.
    it('fetches the manifest with the sign-in cookie', () => {
        expect(indexHtml)
            .toMatch(/<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials" \/>/);
    });

    it('keeps the layout above the phone keyboard', () => {
        expect(indexHtml)
            .toContain('interactive-widget=resizes-content');
    });

    // A page that scrolled moved the whole app on a phone, with the menu button and the pill off the top. See issue #340.
    it('keeps the page itself from scrolling, so only the panels inside the app scroll', () => {
        const pageRule = /html,\s*body\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? '';
        const bodyRule = /\nbody\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? '';

        expect(pageRule)
            .toContain('overflow: hidden');
        expect(pageRule)
            .toContain('overscroll-behavior: none');
        expect(bodyRule)
            .not.toContain('100vh');
    });

    it('gives the root the page height, so the app fits the screen and the composer stays in view', () => {
        const rootRule = /\n#root\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? '';

        expect(rootRule)
            .toContain('height: 100%');
    });

    it('keeps a scroll at the end of the chat inside the message list', () => {
        const listRule = /\n\.message-list\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? '';

        expect(listRule)
            .toContain('overscroll-behavior: contain');
    });
});
