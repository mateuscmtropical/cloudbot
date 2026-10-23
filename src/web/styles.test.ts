import { describe, expect, it } from 'vitest';

import stylesheet from './styles.css?raw';

describe('styles.css', () => {
    it('closes every block, so no rule is swallowed by an open media query', () => {
        const withoutComments = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
        const openCount = withoutComments.split('{').length - 1;
        const closeCount = withoutComments.split('}').length - 1;

        expect(closeCount)
            .toBe(openCount);
    });
});
