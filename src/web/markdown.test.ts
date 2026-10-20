import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './markdown.ts';

describe('renderMarkdown', () => {
    it('renders bold text and lists', () => {
        const html = renderMarkdown('**done**\n\n- one');

        expect(html)
            .toContain('<strong>done</strong>');
        expect(html)
            .toContain('<li>one</li>');
    });

    it('shows raw html as escaped text instead of rendering it', () => {
        const html = renderMarkdown('<img src=x onerror=alert(1)>');

        expect(html)
            .not.toContain('<img');
        expect(html)
            .toContain('&lt;img');
    });

    it('does not turn a javascript link into a clickable href', () => {
        const html = renderMarkdown('[click](javascript:alert(1))');

        expect(html)
            .not.toContain('href="javascript');
    });

    it('opens https links in a new tab without opener access', () => {
        const html = renderMarkdown('[docs](https://example.com)');

        expect(html)
            .toContain('href="https://example.com"');
        expect(html)
            .toContain('rel="noopener noreferrer"');
    });
});
