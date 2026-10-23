import { describe, expect, it } from 'vitest';

import { isValidHubSecret } from './hubSession.ts';

describe('isValidHubSecret', () => {
    it('accepts the configured secret and refuses a wrong secret', () => {
        expect(isValidHubSecret('instance-secret', 'instance-secret'))
            .toBe(true);
        expect(isValidHubSecret('wrong-secret!', 'instance-secret'))
            .toBe(false);
    });

    it('refuses a missing or wrong length secret without throwing', () => {
        expect(isValidHubSecret(undefined, 'instance-secret'))
            .toBe(false);
        expect(isValidHubSecret('short', 'instance-secret'))
            .toBe(false);
    });
});

export {};
