import { describe, expect, it } from 'vitest';

import { checkPersonName } from './peopleTypes.ts';

describe('checkPersonName', () => {
    it('accepts a short lowercase name', () => {
        expect(checkPersonName('maria'))
            .toBeUndefined();
        expect(checkPersonName('joao-2'))
            .toBeUndefined();
    });

    it('refuses a name that cannot be a subdomain', () => {
        expect(checkPersonName('M'))
            .toBeDefined();
        expect(checkPersonName('Maria'))
            .toBeDefined();
        expect(checkPersonName('-maria'))
            .toBeDefined();
        expect(checkPersonName('maria-'))
            .toBeDefined();
        expect(checkPersonName('ma ria'))
            .toBeDefined();
        expect(checkPersonName('a'.repeat(31)))
            .toBeDefined();
    });

    it('refuses a reserved name', () => {
        expect(checkPersonName('hub'))
            .toBe('That name is reserved. Pick another one.');
    });
});
