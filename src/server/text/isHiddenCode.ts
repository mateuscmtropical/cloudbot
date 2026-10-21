// Control characters other than tab and line feed, C1 controls, zero-width and invisible format characters, bidi
// overrides and isolates, line and paragraph separators, the byte order mark, and the language tag block. A carriage
// return is a line end in JavaScript and Python, so it is refused too: a `//` comment would end where the card shows it.
function isHiddenCode(code: number): boolean {
    const isControl = code < 0x20 && code !== 0x09 && code !== 0x0a;
    const isDelete = code >= 0x7f && code <= 0x9f;
    const isSoftHyphen = code === 0x00ad;
    const isArabicLetterMark = code === 0x061c;
    const isZeroWidth = code >= 0x200b && code <= 0x200f;
    const isBidi = code >= 0x202a && code <= 0x202e;
    const isIsolate = code >= 0x2066 && code <= 0x2069;
    const isLineSeparator = code === 0x2028 || code === 0x2029;
    const isWordJoiner = code >= 0x2060 && code <= 0x2064;
    const isTag = code >= 0xe0000 && code <= 0xe007f;

    return isControl || isDelete || isSoftHyphen || isArabicLetterMark || isZeroWidth || isBidi || isIsolate
        || isLineSeparator || isWordJoiner || isTag || code === 0xfeff;
}

// True when the text has a character that could hide what the owner reads. Carriage return is not allowed either.
function hasHiddenCode(text: string): boolean {
    return Array.from(text)
        .some((character) => {
            const code = character.codePointAt(0) ?? 0;

            return isHiddenCode(code);
        });
}

export { hasHiddenCode, isHiddenCode };
