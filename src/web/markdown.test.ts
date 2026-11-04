import { describe, expect, it } from 'vitest';

import { renderDraftMarkdown, renderMarkdown, splitDraftMarkdown } from './markdown.ts';

describe('splitDraftMarkdown', () => {
    it('cuts at a blank line once the next line is complete', () => {
        expect(splitDraftMarkdown('one\n\ntwo\n\nthr'))
            .toEqual(['one\n', 'two\n\nthr']);
        expect(splitDraftMarkdown('one\n\ntwo\n\nthree\n'))
            .toEqual(['one\n', 'two\n', 'three\n']);
    });

    it('never cuts inside a code fence', () => {
        const fenced = '```js\nconst one = 1;\n\nconst two = 2;\n\n~~~\n\n```\n';

        expect(splitDraftMarkdown(`intro\n\n${fenced}\nafter\n`))
            .toEqual(['intro\n', fenced, 'after\n']);
    });

    it('keeps a loose list and its indented content together', () => {
        const list = '- one\n\n  more of one\n\n- two\n';

        expect(splitDraftMarkdown(`before\n\n${list}\nafter\n`))
            .toEqual(['before\n', list, 'after\n']);
    });

    it('renders the same content as the whole text', () => {
        const text = '# Title\n\nSome **bold** text.\n\n- one\n- two\n\n```\ncode\n\nmore\n```\n\n1. first\n\n2. second\n\nThe end.\n';
        const blocks = splitDraftMarkdown(text);
        const joined = blocks.map(block => renderDraftMarkdown(block))
            .join('');

        expect(joined.replaceAll(/\s+/g, ''))
            .toBe(renderMarkdown(text)
                .replaceAll(/\s+/g, ''));
    });
});

describe('renderMarkdown', () => {
    it('gives the same result for the same text from its cache', () => {
        const uniqueText = 'cached **text**';

        expect(renderMarkdown(uniqueText))
            .toBe(renderMarkdown(uniqueText));
        expect(renderMarkdown(uniqueText))
            .toContain('<strong>text</strong>');
    });

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
