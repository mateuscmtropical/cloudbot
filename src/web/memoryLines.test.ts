import { describe, expect, it } from 'vitest';

import { memorySections, withoutMemoryLine } from './memoryLines.ts';

describe('memorySections', () => {
    it('groups lines under their heading and drops list marks and empty headings', () => {
        const text = 'Likes tea\n\n# Family\n- Sister is Ana\n1. Dog is Rex\n\n## Nothing here\n# Work\nStarts at 9\n';

        expect(memorySections(text))
            .toEqual([
                { title: undefined, lines: [{ index: 0, text: 'Likes tea' }] },
                { title: 'Family', lines: [{ index: 3, text: 'Sister is Ana' }, { index: 4, text: 'Dog is Rex' }] },
                { title: 'Work', lines: [{ index: 8, text: 'Starts at 9' }] },
            ]);
    });

    it('has no sections for an empty file', () => {
        expect(memorySections(' \n\n'))
            .toEqual([]);
    });
});

describe('withoutMemoryLine', () => {
    it('removes one line and keeps the rest as written', () => {
        expect(withoutMemoryLine('# Family\n- Ana\n- Rex\n', 1))
            .toBe('# Family\n- Rex\n');
    });
});
