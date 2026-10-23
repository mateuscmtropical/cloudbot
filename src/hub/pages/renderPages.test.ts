import { describe, expect, it } from 'vitest';

import { renderApexPage, renderBusyPage, renderChangePasswordPage, renderLoadingPage, renderLoginPage, renderNotAvailablePage } from './renderPages.ts';

describe('front door pages', () => {
    it('asks for a name on the apex page', () => {
        const page = renderApexPage();

        expect(page.html)
            .toContain('name="name"');
        expect(page.html)
            .toContain('action="/__hub/redirect"');
    });

    it('shows the person name and escapes the login error and extras', () => {
        const page = renderLoginPage({ name: 'maria', error: '<bad>', extras: { html: '<button>Other sign in</button>', script: 'window.extra = true;' } });

        expect(page.html)
            .toContain('Welcome, maria.');
        expect(page.html)
            .toContain('&lt;bad&gt;');
        expect(page.html)
            .toContain('<button>Other sign in</button>');
        expect(page.html)
            .toContain('window.extra = true;');
        expect(page.html)
            .toContain('name="password"');
    });

    it('asks for the new password twice', () => {
        const page = renderChangePasswordPage();

        expect(page.html.match(/type="password"/g))
            .toHaveLength(2);
        expect(page.html)
            .toContain('minlength="10"');
    });

    it('polls while an environment starts and retries a busy server', () => {
        const loading = renderLoadingPage();
        const busy = renderBusyPage();

        expect(loading.html)
            .toContain('fetch(\'/__hub/status\'');
        expect(loading.html)
            .toContain('setTimeout(checkStatus, 2000)');
        expect(loading.html)
            .toContain('<svg');
        expect(busy.html)
            .toContain('setTimeout(() => location.reload(), 2000)');
    });

    it('uses the same plain page for unavailable names', () => {
        const page = renderNotAvailablePage();

        expect(page.html)
            .toContain('<h1>Not available</h1>');
    });
});

export {};
