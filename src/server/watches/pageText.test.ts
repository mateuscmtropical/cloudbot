import { describe, expect, it } from 'vitest';

import { filterLines, htmlToVisibleText, lineDiff } from './pageText.ts';
import { MAX_STORED_TEXT_LENGTH, buildWatchMessage, capStoredText, isWatchMessage } from './watchMessage.ts';

describe('htmlToVisibleText', () => {
    it('keeps the visible text, one line per block, and drops scripts, styles and comments', () => {
        const html = '<html><head><style>p { color: red }</style><script>var x = "<b>no</b>";</script></head>'
            + '<body><!-- hidden --><h1>Prices</h1><p>Tea &amp; coffee</p><p>Milk&nbsp;&nbsp;  2 &#36;</p></body></html>';

        expect(htmlToVisibleText(html))
            .toBe('Prices\nTea & coffee\nMilk 2 $');
    });

    it('turns br tags into line breaks and removes the other tags', () => {
        expect(htmlToVisibleText('<span>Stock:</span><br>In <b>stock</b>'))
            .toBe('Stock:\nIn stock');
    });

    it('does not decode an invalid code point', () => {
        expect(htmlToVisibleText('a &#x110000; b'))
            .toBe('a b');
    });

    it('stays fast on 1 MB of hostile markup', () => {
        const megabyte = 1024 * 1024;
        const inputs = [
            '<'.repeat(megabyte),
            '<'.repeat(megabyte - 1) + '>',
            '<script'.repeat(Math.floor(megabyte / 7)),
            '<!--'.repeat(Math.floor(megabyte / 4)),
            '< '.repeat(Math.floor(megabyte / 2)),
            '<a'.repeat(Math.floor(megabyte / 2)) + '>',
        ];

        inputs.forEach((input) => {
            const started = performance.now();

            htmlToVisibleText(input);
            const elapsed = performance.now() - started;

            expect(elapsed)
                .toBeLessThan(500);
        });
    });

    it('drops unclosed markup at the end of the input', () => {
        expect(htmlToVisibleText('<p>hi</p><!-- SECRET'))
            .toBe('hi');
        expect(htmlToVisibleText('<p>hi</p><b SECRET'))
            .toBe('hi');
    });

    it('keeps a plain less-than sign in the tail', () => {
        expect(htmlToVisibleText('<p>x</p>a < b'))
            .toBe('x\na < b');
    });

    it('does not close a script with a style closer', () => {
        expect(htmlToVisibleText('<script>SECRET</style>TAIL'))
            .toBe('');
        expect(htmlToVisibleText('<style>p{}</style>TAIL'))
            .toBe('TAIL');
    });

    it('keeps text that has a less-than sign or a greater-than sign in it', () => {
        expect(htmlToVisibleText('<p>x < 5</p><p>y > 3</p>'))
            .toBe('x < 5\ny > 3');
        expect(htmlToVisibleText('if a < b and c > d then'))
            .toBe('if a < b and c > d then');
    });
});

describe('filterLines', () => {
    it('keeps only the lines with the keyword, ignoring case', () => {
        expect(filterLines('Bread 2\nMilk 1\nbread rolls 3', 'BREAD'))
            .toBe('Bread 2\nbread rolls 3');
    });

    it('keeps the whole text when there is no keyword', () => {
        expect(filterLines('one\ntwo', undefined))
            .toBe('one\ntwo');
        expect(filterLines('one\ntwo', '   '))
            .toBe('one\ntwo');
    });
});

describe('lineDiff', () => {
    it('marks the lines that left with a minus and the new ones with a plus', () => {
        expect(lineDiff('a\nb\nc', 'a\nc\nd'))
            .toEqual(['- b', '+ d']);
    });

    it('is empty when only the order of the lines changed', () => {
        expect(lineDiff('a\nb', 'b\na'))
            .toEqual([]);
    });
});

describe('watch message', () => {
    it('marks the page text as outside data and names the page', () => {
        const message = buildWatchMessage('Shop', 'https://shop.example.test/', ['+ Bread 2']);

        expect(isWatchMessage(message))
            .toBe(true);
        expect(message)
            .toContain('+ Bread 2');
    });

    it('caps a long diff and says how many lines are left out', () => {
        const longLines = Array.from({ length: 25 }, (_unused, index) => `+ line ${String(index)}`);
        const message = buildWatchMessage('Shop', 'https://shop.example.test/', longLines);

        expect(message)
            .toContain('... and 5 more changed lines.');
        expect(message)
            .not.toContain('line 24');
    });

    it('does not take an owner message for a page watch message', () => {
        expect(isWatchMessage('Page watch is a phrase I typed'))
            .toBe(false);
    });

    it('caps the stored text', () => {
        expect(capStoredText('x'.repeat(MAX_STORED_TEXT_LENGTH + 10)))
            .toHaveLength(MAX_STORED_TEXT_LENGTH);
    });
});
