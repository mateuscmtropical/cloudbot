import { describe, expect, it } from 'vitest';

import { MAX_NOTICE_LINE_CHARACTERS, firstReplyLine, toNoticeLine } from './noticeLine.ts';

describe('firstReplyLine', () => {
    it('takes the first line with words and drops its Markdown marks', () => {
        expect(firstReplyLine('\n---\n## **Resumo diário** pronto\n\nMais texto'))
            .toBe('Resumo diário pronto');
    });

    it('keeps the label of a link and drops list marks', () => {
        expect(firstReplyLine('- Veja [o relatório](https://example.com/r) agora'))
            .toBe('Veja o relatório agora');
    });

    it('cuts a long line with an ellipsis', () => {
        const line = firstReplyLine('a'.repeat(300)) ?? '';

        expect(Array.from(line))
            .toHaveLength(MAX_NOTICE_LINE_CHARACTERS);
        expect(line.endsWith('…'))
            .toBe(true);
    });

    it('returns undefined for a reply without words', () => {
        expect(firstReplyLine('---\n\n***'))
            .toBeUndefined();
    });
});

describe('toNoticeLine', () => {
    it('collapses spaces and line breaks', () => {
        expect(toNoticeLine('  Resumo\n pronto  '))
            .toBe('Resumo pronto');
    });

    it('returns undefined for blank text', () => {
        expect(toNoticeLine(' \n '))
            .toBeUndefined();
    });
});
