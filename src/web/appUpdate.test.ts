// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isNewAppBuild, parseAppBuild } from './appUpdate.ts';

const BASE_URL = 'https://cloudbot.example/';

interface HappyDomTestWindow extends Window {
    happyDOM: {
        settings: {
            disableCSSFileLoading: boolean;
            disableJavaScriptFileLoading: boolean;
            handleDisabledFileLoadingAsSuccess: boolean;
        };
    };
}

function parseDocument(html: string): Document {
    const parser = new DOMParser();

    return parser.parseFromString(html, 'text/html');
}

beforeEach(() => {
    const happyDomWindow = window as unknown as HappyDomTestWindow;

    happyDomWindow.happyDOM.settings.disableCSSFileLoading = true;
    happyDomWindow.happyDOM.settings.disableJavaScriptFileLoading = true;
    happyDomWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
});

afterEach(() => {
    vi.restoreAllMocks();
    const happyDomWindow = window as unknown as HappyDomTestWindow;

    happyDomWindow.happyDOM.settings.disableCSSFileLoading = false;
    happyDomWindow.happyDOM.settings.disableJavaScriptFileLoading = false;
    happyDomWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = false;
});

describe('parseAppBuild', () => {
    it('reads the hashed module script and stylesheet paths', () => {
        const document = parseDocument('<script type="module" src="/assets/main-abc12345.js"></script><link rel="stylesheet" href="/assets/main-def67890.css">');

        expect(parseAppBuild(document, BASE_URL))
            .toEqual({ moduleScript: '/assets/main-abc12345.js', stylesheets: ['/assets/main-def67890.css'] });
    });

    it('ignores a page without a module script and development assets without hashes', () => {
        const signInPage = parseDocument('<main>Sign in</main>');
        const developmentPage = parseDocument('<script type="module" src="/src/main.tsx"></script>');

        expect(parseAppBuild(signInPage, BASE_URL))
            .toBeUndefined();
        expect(parseAppBuild(developmentPage, BASE_URL))
            .toBeUndefined();
    });
});

describe('isNewAppBuild', () => {
    it('detects a changed script or stylesheet and ignores missing builds', () => {
        const currentBuild = parseAppBuild(parseDocument('<script type="module" src="/assets/main-abc12345.js"></script><link rel="stylesheet" href="/assets/main-def67890.css">'), BASE_URL);
        const changedScript = parseAppBuild(parseDocument('<script type="module" src="/assets/main-bcd23456.js"></script><link rel="stylesheet" href="/assets/main-def67890.css">'), BASE_URL);
        const changedStyle = parseAppBuild(parseDocument('<script type="module" src="/assets/main-abc12345.js"></script><link rel="stylesheet" href="/assets/main-efg78901.css">'), BASE_URL);

        expect(isNewAppBuild(currentBuild, changedScript))
            .toBe(true);
        expect(isNewAppBuild(currentBuild, changedStyle))
            .toBe(true);
        expect(isNewAppBuild(currentBuild, undefined))
            .toBe(false);
    });
});
