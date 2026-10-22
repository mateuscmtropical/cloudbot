import { describe, expect, it } from 'vitest';

import { createStreamMasker, findSensitiveNumbers, findSensitiveRefusal, hasSensitiveNumber, maskSensitiveNumbers } from './sensitiveNumbers.ts';

describe('card numbers', () => {
    it.each([
        ['4111 1111 1111 1111', 'a Visa with spaces'],
        ['4111-1111-1111-1111', 'a Visa with dashes'],
        ['4111111111111111', 'a Visa without separators'],
        ['5555 5555 5555 4444', 'a Mastercard'],
        ['378282246310005', 'a 15 digit Amex'],
    ])('finds %s, %s', (number) => {
        expect(hasSensitiveNumber(`my number is ${number} thanks`))
            .toBe(true);
    });

    it('refuses a number that fails the Luhn check', () => {
        expect(hasSensitiveNumber('4111 1111 1111 1112'))
            .toBe(false);
    });

    it('does not treat a 13 digit timestamp that starts with 1 as a card', () => {
        expect(hasSensitiveNumber('created at 1700000000000'))
            .toBe(false);
    });

    it('does not find a card inside a longer run of digits', () => {
        expect(hasSensitiveNumber('order 41111111111111111111234'))
            .toBe(false);
    });
});

describe('CPF numbers', () => {
    it('finds a formatted CPF with valid check digits', () => {
        const findings = findSensitiveNumbers('CPF 529.982.247-25 aqui');

        expect(findings.map(finding => finding.kind))
            .toEqual(['cpf']);
    });

    it('finds a plain 11 digit CPF with valid check digits when the word CPF comes before it', () => {
        expect(hasSensitiveNumber('CPF 52998224725'))
            .toBe(true);
        expect(hasSensitiveNumber('cpf: 52998224725'))
            .toBe(true);
    });

    it('does not take a mobile phone number for a CPF, even when its digits pass the check', () => {
        expect(hasSensitiveNumber('Me ligue no 11987654321 amanhã'))
            .toBe(false);
        expect(hasSensitiveNumber('phone 52998224725'))
            .toBe(false);
    });

    it('refuses a CPF with wrong check digits', () => {
        expect(hasSensitiveNumber('529.982.247-26'))
            .toBe(false);
    });

    it('refuses a CPF made of one repeated digit', () => {
        expect(hasSensitiveNumber('111.111.111-11'))
            .toBe(false);
    });
});

describe('SSN numbers', () => {
    it('finds a US SSN with dashes', () => {
        const findings = findSensitiveNumbers('SSN 078-05-1120.');

        expect(findings.map(finding => finding.kind))
            .toEqual(['ssn']);
    });

    it.each(['000-12-3456', '666-12-3456', '900-12-3456', '123-00-4567', '123-45-0000'])('refuses %s, which is never issued', (number) => {
        expect(hasSensitiveNumber(number))
            .toBe(false);
    });
});

describe('maskSensitiveNumbers', () => {
    it('keeps only the last four digits of a card and keeps the text around it', () => {
        expect(maskSensitiveNumbers('Card 4111 1111 1111 1111 ok'))
            .toBe('Card **** **** **** 1111 ok');
    });

    it('keeps the length of the text', () => {
        const text = 'CPF 529.982.247-25 and SSN 078-05-1120';

        expect(maskSensitiveNumbers(text))
            .toHaveLength(text.length);
    });

    it('leaves text without a number as it is', () => {
        expect(maskSensitiveNumbers('Plan the trip for 3 people in May.'))
            .toBe('Plan the trip for 3 people in May.');
    });
});

describe('findSensitiveRefusal', () => {
    it('names the kind of number without repeating it', () => {
        const refusal = findSensitiveRefusal('4111 1111 1111 1111');

        expect(refusal)
            .toContain('a payment card number');
        expect(refusal)
            .not.toContain('4111');
    });

    it('returns undefined for clean text', () => {
        expect(findSensitiveRefusal('Hello there'))
            .toBeUndefined();
    });
});

describe('createStreamMasker', () => {
    it('masks a card number that arrives in pieces', () => {
        const masker = createStreamMasker();
        const first = masker.push('Your card is 4111 11');
        const second = masker.push('11 1111 1111 ok');
        const shown = first + second + masker.finish();

        expect(shown)
            .toBe('Your card is **** **** **** 1111 ok');
    });

    it('holds back a trailing number until the text after it arrives', () => {
        const masker = createStreamMasker();

        expect(masker.push('Total 4111 1111 1111 1111'))
            .toBe('Total');
        expect(masker.finish())
            .toBe(' **** **** **** 1111');
    });

    it('shows plain words at once', () => {
        const masker = createStreamMasker();

        expect(masker.push('Hello'))
            .toBe('Hello');
    });
});

describe('card false positives', () => {
    it.each([
        ['+5541999998888', 'an E.164 phone number'],
        ['tel:+5541999998888', 'a phone number after tel:'],
        ['wa.me/5541999998888', 'a WhatsApp link'],
        ['41.234.567/0001-95', 'a CNPJ'],
        ['7891234567894', 'an EAN-13 barcode that passes Luhn'],
        ['commit 4111111111111111a3f9c0d2e1b4f5a6c7d8e9f0', 'a 40 character git sha with a digit run'],
    ])('does not take %s, %s, for a card', (text) => {
        expect(hasSensitiveNumber(text))
            .toBe(false);
    });

    it('does not match a card with a brand prefix and the wrong length', () => {
        expect(hasSensitiveNumber('4111 1111 1111 111'))
            .toBe(false);
        expect(hasSensitiveNumber('378282246310005 extra 1'))
            .toBe(true);
    });

    it('finds a card whose groups are split by a dot, an underscore or a non-breaking space', () => {
        expect(hasSensitiveNumber('4111.1111.1111.1111'))
            .toBe(true);
        expect(hasSensitiveNumber('4111__1111__1111__1111'))
            .toBe(true);
        expect(hasSensitiveNumber('4111\u00a01111\u00a01111\u00a01111'))
            .toBe(true);
    });

    it('finds a card with two spaces between groups', () => {
        expect(hasSensitiveNumber('4111  1111 1111 1111'))
            .toBe(true);
    });

    it('does not split a card with three separators in a row', () => {
        expect(hasSensitiveNumber('4111 - - 1111 1111 1111'))
            .toBe(false);
    });
});

describe('streamed sensitive text', () => {
    it('masks a CPF whose label arrives before its digits', () => {
        const masker = createStreamMasker();
        const first = masker.push('Your CPF 52998224725');
        const shown = first + masker.finish();

        expect(shown)
            .toBe('Your CPF *******4725');
    });

    it('holds the digits of a card until the text after them arrives', () => {
        const masker = createStreamMasker();

        expect(masker.push('Card 4111 11'))
            .toBe('Card');
        expect(masker.push('11 1111 1111 ok'))
            .toBe(' **** **** **** 1111 ok');
    });
});

describe('hex ids and invisible characters', () => {
    it.each([
        ['Visa4111111111111111', 'a card with a letter before it'],
        ['deadbeef4111111111111111', 'a card after a short hex word'],
        ['Card 4111\u200b1111\u200b1111\u200b1111', 'a card with zero-width spaces'],
    ])('finds %s, %s', (text) => {
        expect(hasSensitiveNumber(text))
            .toBe(true);
    });

    it('skips a card that sits inside a hex id of 32 characters or more', () => {
        expect(hasSensitiveNumber('commit 4111111111111111a3f9c0d2e1b4f5a6c7d8e9f0'))
            .toBe(false);
    });

    it('masks a card with zero-width characters inside it', () => {
        expect(maskSensitiveNumbers('Card 4111\u200b1111\u200b1111\u200b1111'))
            .toBe('Card ************1111');
    });
});

describe('card brands', () => {
    it.each([
        ['2221000000000009', 'the first Mastercard 2-series prefix'],
        ['2720000000000005', 'the last Mastercard 2-series prefix'],
        ['6212000000000001', 'a UnionPay card'],
        ['5020000000000005', 'a Maestro card'],
        ['6761000000000006', 'a Maestro card with a 6761 prefix'],
    ])('finds %s, %s', (number) => {
        expect(hasSensitiveNumber(`number ${number} ok`))
            .toBe(true);
    });

    it.each([
        ['2220000000000000', 'just below the Mastercard 2-series range'],
        ['2721000000000004', 'just above the Mastercard 2-series range'],
    ])('does not take %s, %s, for a card', (number) => {
        expect(hasSensitiveNumber(`number ${number} ok`))
            .toBe(false);
    });

    it('does not take a 13 digit Visa-looking number for a card, since Visa is 16 or 19 digits', () => {
        expect(hasSensitiveNumber('4222222222222'))
            .toBe(false);
    });
});

describe('streamed card labels', () => {
    it.each([
        ['Your C', 'PF 52998224725 ok'],
        ['Your CP', 'F 52998224725 ok'],
        ['Your CPF', ' 52998224725 ok'],
    ])('holds back a trailing label, then masks the CPF once its digits arrive (%s)', (head, tail) => {
        const masker = createStreamMasker();

        expect(masker.push(head))
            .toBe('Your ');
        expect(masker.push(tail))
            .toBe('CPF *******4725 ok');
    });
});
