// A simple reader for the visible text of a page. It is not a full HTML parser: it drops scripts, styles and
// comments, turns block tags into line breaks and removes the other tags. Lines are what the diff compares.
const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: '\'',
    nbsp: ' ',
};
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'tr', 'table', 'section', 'article', 'header', 'footer', 'blockquote', 'pre']);
// One markup token per match, tried in this order: a comment, a script, style or noscript element, any tag, text, or a lone '<'.
// A comment or hidden element that is not closed runs to the end of the input, as in a browser, and is consumed in one match.
// A tag starts with a letter, '/', '!' or '?', so '<' before a space or a digit is text ("a < b").
// Every tag start in the input is followed by a '>' (see stripMarkup), so a tag match ends at the next '>' and never backtracks far.
const MARKUP_PATTERN = /<!--[\s\S]*?(?:-->|$)|<(script|style|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<[a-zA-Z/!?][^>]*>|[^<]+|</gi;
const TAG_NAME_PATTERN = /^<\/?([a-zA-Z][a-zA-Z0-9]{0,30})/;
const HIDDEN_CLOSE_PATTERN = /<\/(script|style|noscript)\s*>$/i;
const HIDDEN_OPEN_PATTERN = /^<(script|style|noscript)\b/i;
// Unclosed markup at the end of the input is dropped, as a browser does: the tail is cut at its first tag start.
const TAIL_TAG_START_PATTERN = /<[a-zA-Z!/?]/;
const ENTITY_PATTERN = /&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,8}|[a-zA-Z]{1,8});/g;

function decodeEntity(entity: string): string {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const hexDigits = entity.slice(2);
        const hexCodePoint = Number.parseInt(hexDigits, 16);

        return decodeCodePoint(hexCodePoint);
    }

    if (entity.startsWith('#')) {
        const decimalDigits = entity.slice(1);
        const decimalCodePoint = Number.parseInt(decimalDigits, 10);

        return decodeCodePoint(decimalCodePoint);
    }

    return NAMED_ENTITIES[entity] ?? `&${entity};`;
}

function decodeCodePoint(codePoint: number): string {
    const isValid = Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF;

    return isValid ? String.fromCodePoint(codePoint) : '';
}

// Each line is trimmed and its runs of spaces become one space. Empty lines are dropped.
function normalizeLines(text: string): string {
    const lines = text.split('\n')
        .map(line => line.replace(/\s+/g, ' ')
            .trim())
        .filter(line => line !== '');

    return lines.join('\n');
}

// Each markup token becomes a space, a line break (block tags) or itself (text and a lone '<').
// Text after the last '>' has no tag end, so it is appended up to its first tag start. If the last hidden element
// or comment was never closed, the browser would hide that text too, so it is dropped.
function stripMarkup(html: string): string {
    const lastGreater = html.lastIndexOf('>');
    const head = html.slice(0, lastGreater + 1);
    const rawTail = html.slice(lastGreater + 1);
    const tailTagStart = rawTail.search(TAIL_TAG_START_PATTERN);
    const tail = tailTagStart === -1 ? rawTail : rawTail.slice(0, tailTagStart);
    const state = { isInsideUnclosed: false };
    const stripped = head.replace(MARKUP_PATTERN, (token: string) => {
        if (token === '<' || !token.startsWith('<')) {
            return token;
        }

        if (token.startsWith('<!--')) {
            const isClosed = token.length >= 7 && token.endsWith('-->');

            state.isInsideUnclosed = state.isInsideUnclosed || !isClosed;

            return ' ';
        }

        if (HIDDEN_OPEN_PATTERN.test(token)) {
            const openName = HIDDEN_OPEN_PATTERN.exec(token)?.[1]?.toLowerCase();
            const closeName = HIDDEN_CLOSE_PATTERN.exec(token)?.[1]?.toLowerCase();
            const isClosed = openName !== undefined && openName === closeName;

            state.isInsideUnclosed = state.isInsideUnclosed || !isClosed;

            return ' ';
        }

        const tagMatch = TAG_NAME_PATTERN.exec(token);
        const tagName = tagMatch?.[1]?.toLowerCase() ?? '';

        return BLOCK_TAGS.has(tagName) ? '\n' : ' ';
    });

    return state.isInsideUnclosed ? stripped : stripped + tail;
}

function decodeEntities(text: string): string {
    return text.replace(ENTITY_PATTERN, (_match, entity: string) => decodeEntity(entity));
}

function htmlToVisibleText(html: string): string {
    const stripped = stripMarkup(html);
    const decoded = decodeEntities(stripped);

    return normalizeLines(decoded);
}

// Keeps only the lines that contain the keyword, ignoring case. No keyword keeps the whole text.
function filterLines(text: string, keyword: string | undefined): string {
    if (keyword === undefined || keyword.trim() === '') {
        return text;
    }

    const wanted = keyword.trim()
        .toLowerCase();
    const matchingLines = text.split('\n')
        .filter(line => line.toLowerCase()
            .includes(wanted));

    return matchingLines.join('\n');
}

function nonEmptyLines(text: string): string[] {
    const lines = text.split('\n');

    return lines.filter(line => line !== '');
}

// Lines that left the text are marked "- ", lines that came are marked "+ ". The order of the lines is not compared.
function lineDiff(oldText: string, newText: string): string[] {
    const oldList = nonEmptyLines(oldText);
    const newList = nonEmptyLines(newText);
    const oldLines = new Set(oldList);
    const newLines = new Set(newList);
    const removedLines = [...oldLines].filter(line => !newLines.has(line))
        .map(line => `- ${line}`);
    const addedLines = [...newLines].filter(line => !oldLines.has(line))
        .map(line => `+ ${line}`);

    return [...removedLines, ...addedLines];
}

export { filterLines, htmlToVisibleText, lineDiff, normalizeLines };
