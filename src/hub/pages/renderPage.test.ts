import { describe, expect, it } from 'vitest';

import { escapeHtml, renderPage } from './renderPage.ts';

describe('renderPage', () => {
    it('renders the responsive page shell and a fresh script nonce', () => {
        const first = renderPage({ title: 'Sign in', body: '<main>Welcome</main>', scripts: ['window.ready = true;'] });
        const second = renderPage({ title: 'Sign in', body: '<main>Welcome</main>', scripts: ['window.ready = true;'] });
        const firstNonce = first.csp.match(/nonce-([^']+)/)?.[1];

        expect(first.html)
            .toContain('background: #1b1b1f');
        expect(first.html)
            .toContain('border-radius: 18px');
        expect(firstNonce)
            .toBeDefined();

        if (firstNonce === undefined) {
            throw new Error('The page did not include a script nonce.');
        }

        expect(first.html)
            .toContain(`<script nonce="${firstNonce}">window.ready = true;</script>`);
        expect(first.csp)
            .toContain('default-src \'none\'');
        expect(first.csp)
            .toContain('connect-src \'self\'');
        expect(first.csp)
            .not.toBe(second.csp);
    });

    it('escapes text inserted into a page', () => {
        expect(escapeHtml('<img src="x" onerror=alert(1)>'))
            .toBe('&lt;img src=&quot;x&quot; onerror=alert(1)&gt;');
    });
});

export {};
