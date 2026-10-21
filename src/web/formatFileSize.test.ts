import { describe, expect, it } from 'vitest';

import { formatFileSize } from './formatFileSize.ts';

describe('formatFileSize', () => {
    it.each([
        [0, '0 B'],
        [999, '999 B'],
        [1536, '1.5 KB'],
        [20 * 1024, '20 KB'],
        [5 * 1024 * 1024, '5.0 MB'],
        [3 * 1024 * 1024 * 1024, '3.0 GB'],
    ])('formats %i bytes as %s', (sizeBytes, expected) => {
        expect(formatFileSize(sizeBytes))
            .toBe(expected);
    });
});
