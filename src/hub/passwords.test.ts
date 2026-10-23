import { describe, expect, it } from 'vitest';

import { generatePassword, hashPassword, verifyPassword } from './passwords.ts';

describe('passwords', () => {
    it('verifies the password that was hashed', async () => {
        const stored = await hashPassword('correct horse');

        expect(await verifyPassword('correct horse', stored))
            .toBe(true);
        expect(await verifyPassword('wrong horse', stored))
            .toBe(false);
    });

    it('gives each hash its own salt', async () => {
        const first = await hashPassword('same');
        const second = await hashPassword('same');

        expect(first)
            .not
            .toBe(second);
    });

    it('never matches a stored value in the wrong form', async () => {
        expect(await verifyPassword('x', ''))
            .toBe(false);
        expect(await verifyPassword('x', 'scrypt$zz'))
            .toBe(false);
        expect(await verifyPassword('x', 'bcrypt$aa$bb'))
            .toBe(false);
    });

    it('generates a 16 character password from the safe alphabet', () => {
        const password = generatePassword();

        expect(password)
            .toMatch(/^[a-hj-km-np-zA-HJ-KM-NP-Z2-9]{16}$/);
        expect(generatePassword())
            .not
            .toBe(password);
    });
});
