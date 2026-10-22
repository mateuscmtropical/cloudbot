type SensitiveNumberKind = 'card' | 'cpf' | 'ssn';

interface SensitiveNumberFinding {
    kind: SensitiveNumberKind;
    start: number;
    end: number;
}

interface NumberDetector {
    kind: SensitiveNumberKind;
    pattern: RegExp;
    isValid: (candidate: string) => boolean;
}

interface StreamMasker {
    // Returns the part of the text that is safe to show now. A number still being typed is held back.
    push: (delta: string) => string;
    // Returns what is still held back, masked. Call it when the text ends.
    finish: () => string;
}

interface CardBrand {
    prefix: RegExp;
    lengths: number[];
}

const VISIBLE_DIGIT_COUNT = 4;
const REPEATED_DIGIT_PATTERN = /^(\d)\1{10}$/;
// Digits, separators and a CPF label can still grow into a number, so they are held back in a stream.
const HELD_TAIL_PATTERN = /(?:\bC(?:P(?:F)?)?:? ?)?[0-9 ._/\u00a0\u200b-\u200d\u2060\ufeff-]*$/i;
// A number this long is not a card, CPF or SSN, so the held text is released masked.
const STREAM_HOLD_LIMIT = 64;

// The brand prefixes and the lengths each one issues. A number that fits none of them is not a card.
const CARD_BRANDS: CardBrand[] = [
    { prefix: /^4/, lengths: [16, 19] },
    { prefix: /^(?:5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)/, lengths: [16] },
    { prefix: /^3[47]/, lengths: [15] },
    { prefix: /^(?:6011|65|64[4-9])/, lengths: [16, 17, 18, 19] },
    { prefix: /^(?:36|38|30[0-5])/, lengths: [14, 15, 16, 17, 18, 19] },
    { prefix: /^35(?:2[89]|[3-8]\d)/, lengths: [16, 17, 18, 19] },
    { prefix: /^(?:4011|4389|4514|4576|5041|5066|5067|6277|6362|6363|6504|6505|6516|6550)/, lengths: [16] },
    { prefix: /^(?:606282|3841)/, lengths: [16] },
    { prefix: /^62/, lengths: [16, 17, 18, 19] },
    { prefix: /^(?:50|5[68]|63|67|6759|676[1-3])/, lengths: [12, 13, 14, 15, 16, 17, 18, 19] },
];

// A card is 13 to 19 digits. Up to two separators may sit between digits. A plus, a tel: or wa.me/ label, or a digit before it is not part of it.
// A hex id is checked in code, because a letter next to a card is not enough to hide it.
const CARD_PATTERN = /(?<!\+|tel:|wa\.me\/|\d)\d(?!\.)(?:[ ._/\u00a0-]{0,2}\d){12,18}(?!\d)/g;
const CPF_FORMATTED_PATTERN = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
// Eleven plain digits are also common in phone numbers, so they count as a CPF only right after the word CPF.
const CPF_PLAIN_PATTERN = /(?<=\bCPF:? ?)\d{11}(?!\d)/gi;
const SSN_PATTERN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g;

const KIND_LABELS: Record<SensitiveNumberKind, string> = {
    card: 'a payment card number',
    cpf: 'a Brazilian CPF number',
    ssn: 'a US Social Security number',
};

// Zero-width characters are removed before matching, so they cannot split a number.
const INVISIBLE_CHARACTER_PATTERN = /[\u200b-\u200d\u2060\ufeff]/g;
const HEX_ONLY_PATTERN = /^[0-9A-Fa-f]+$/;
const HEX_BEFORE_PATTERN = /[0-9A-Fa-f]*$/;
const HEX_AFTER_PATTERN = /^[0-9A-Fa-f]*/;
// A candidate inside a hex id this long, such as a git sha, is not a number.
const LONG_HEX_RUN_LENGTH = 32;

function stripInvisible(text: string): string {
    return text.replace(INVISIBLE_CHARACTER_PATTERN, '');
}

function isInLongHexRun(text: string, start: number, end: number): boolean {
    const candidate = text.slice(start, end);
    const innerLength = HEX_ONLY_PATTERN.test(candidate) ? candidate.length : 0;
    const hexBefore = text.slice(0, start)
        .match(HEX_BEFORE_PATTERN)?.[0].length ?? 0;
    const hexAfter = text.slice(end)
        .match(HEX_AFTER_PATTERN)?.[0].length ?? 0;

    return hexBefore + innerLength + hexAfter >= LONG_HEX_RUN_LENGTH;
}

function removeSeparators(candidate: string): string {
    return candidate.replace(/[ ._/\u00a0-]/g, '');
}

function passesLuhn(digits: string): boolean {
    const digitValues = digits.split('')
        .map(digit => Number(digit))
        .reverse();
    const weightedSum = digitValues.reduce((total, value, index) => {
        if (index % 2 === 0) {
            return total + value;
        }

        const doubled = value * 2;

        return total + (doubled > 9 ? doubled - 9 : doubled);
    }, 0);

    return weightedSum % 10 === 0;
}

function isCardNumber(candidate: string): boolean {
    const digits = removeSeparators(candidate);
    // Plain digit runs such as timestamps or ids rarely match a brand prefix and length, so the check filters them.
    const isKnownBrand = CARD_BRANDS.some(brand => brand.prefix.test(digits) && brand.lengths.includes(digits.length));

    return isKnownBrand && passesLuhn(digits);
}

// The check digit of a CPF is computed from the digits before it, with weights that count down.
function cpfCheckDigit(digits: string, count: number): number {
    const weightedSum = digits.slice(0, count)
        .split('')
        .map(digit => Number(digit))
        .reduce((total, value, index) => total + value * (count + 1 - index), 0);
    const remainder = weightedSum % 11;

    return remainder < 2 ? 0 : 11 - remainder;
}

function isCpfNumber(candidate: string): boolean {
    const digits = candidate.replace(/\D/g, '');

    if (digits.length !== 11 || REPEATED_DIGIT_PATTERN.test(digits)) {
        return false;
    }

    const firstCheckDigit = cpfCheckDigit(digits, 9);
    const secondCheckDigit = cpfCheckDigit(digits, 10);
    const firstCheck = String(firstCheckDigit);
    const secondCheck = String(secondCheckDigit);

    return digits.charAt(9) === firstCheck && digits.charAt(10) === secondCheck;
}

// The SSN area 000, 666 and 900 to 999 are never issued, and neither are group 00 or serial 0000.
function isSsnNumber(candidate: string): boolean {
    const area = candidate.slice(0, 3);
    const group = candidate.slice(4, 6);
    const serial = candidate.slice(7);

    return area !== '000' && area !== '666' && !area.startsWith('9') && group !== '00' && serial !== '0000';
}

const DETECTORS: NumberDetector[] = [
    { kind: 'card', pattern: CARD_PATTERN, isValid: isCardNumber },
    { kind: 'cpf', pattern: CPF_FORMATTED_PATTERN, isValid: isCpfNumber },
    { kind: 'cpf', pattern: CPF_PLAIN_PATTERN, isValid: isCpfNumber },
    { kind: 'ssn', pattern: SSN_PATTERN, isValid: isSsnNumber },
];

function findSensitiveNumbers(text: string): SensitiveNumberFinding[] {
    const visibleText = stripInvisible(text);
    const findings = DETECTORS.flatMap((detector) => {
        const matches = [...visibleText.matchAll(detector.pattern)];

        return matches
            .map(match => ({ kind: detector.kind, candidate: match[0], start: match.index, end: match.index + match[0].length }))
            .filter(finding => detector.isValid(finding.candidate) && !isInLongHexRun(visibleText, finding.start, finding.end))
            .map(finding => ({ kind: finding.kind, start: finding.start, end: finding.end }));
    });

    return findings.sort((first, second) => first.start - second.start);
}

function hasSensitiveNumber(text: string): boolean {
    return findSensitiveNumbers(text).length > 0;
}

// Only the last digits stay readable. Separators stay, so the shape of the number is still visible.
function maskDigits(candidate: string): string {
    const characters = Array.from(candidate);
    const digitPositions = characters.flatMap((character, index) => (/\d/.test(character) ? [index] : []));
    const visibleDigitPositions = digitPositions.slice(-VISIBLE_DIGIT_COUNT);
    const visiblePositions = new Set(visibleDigitPositions);

    return characters
        .map((character, index) => (/\d/.test(character) && !visiblePositions.has(index) ? '*' : character))
        .join('');
}

// Masking keeps the length of the visible text, so the masked digits stay in the same places.
function maskSensitiveNumbers(text: string): string {
    const replaceCandidate = (detector: NumberDetector, candidate: string, offset: number, source: string): string => {
        const isSensitive = detector.isValid(candidate) && !isInLongHexRun(source, offset, offset + candidate.length);

        return isSensitive ? maskDigits(candidate) : candidate;
    };

    const maskWithDetector = (masked: string, detector: NumberDetector): string => {
        const replaceMatch = (candidate: string, offset: number, source: string): string => replaceCandidate(detector, candidate, offset, source);

        return masked.replace(detector.pattern, replaceMatch);
    };

    const visibleText = stripInvisible(text);

    return DETECTORS.reduce(maskWithDetector, visibleText);
}

function heldTailLength(text: string): number {
    const tailMatch = HELD_TAIL_PATTERN.exec(text);
    const tail = tailMatch?.[0] ?? '';

    return tail.length;
}

// A number can arrive in pieces. The text is cut only where no number can continue, so a piece is never masked too late.
function createStreamMasker(): StreamMasker {
    let pending = '';

    return {
        push(delta: string): string {
            pending += delta;

            const heldLength = heldTailLength(pending);

            if (heldLength > STREAM_HOLD_LIMIT) {
                const releasedAll = maskSensitiveNumbers(pending);

                pending = '';

                return releasedAll;
            }

            const cut = pending.length - heldLength;
            const released = pending.slice(0, cut);

            pending = pending.slice(cut);

            return maskSensitiveNumbers(released);
        },
        finish(): string {
            const remaining = maskSensitiveNumbers(pending);

            pending = '';

            return remaining;
        },
    };
}

// The owner and the bot see the same short reason. It names the kind of number and never the number.
function describeSensitiveRefusal(kinds: SensitiveNumberKind[]): string {
    const uniqueKinds = kinds.filter((kind, index) => kinds.indexOf(kind) === index);
    const labels = uniqueKinds.map(kind => KIND_LABELS[kind]);
    const labelText = labels.join(' and ');

    return `The text holds ${labelText}, so the call was not run. Do not send it. Ask the owner to give it in the secure form with request_secret, then carry on without it.`;
}

// The refusal for a text that holds a number, or undefined when the text is clean.
function findSensitiveRefusal(text: string): string | undefined {
    const kinds: SensitiveNumberKind[] = findSensitiveNumbers(text)
        .map(finding => finding.kind);

    return kinds.length === 0 ? undefined : describeSensitiveRefusal(kinds);
}

export { createStreamMasker, describeSensitiveRefusal, findSensitiveNumbers, findSensitiveRefusal, hasSensitiveNumber, maskSensitiveNumbers };
export type { SensitiveNumberFinding, SensitiveNumberKind, StreamMasker };
