// The longest line a notification shows. A longer one is cut with an ellipsis, and the whole payload stays far under 4 KB.
const MAX_NOTICE_LINE_CHARACTERS = 160;
// Markdown marks at the start of a line: headings, quotes, list bullets and numbers.
const LEADING_MARKS_PATTERN = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/;
// Emphasis and code marks inside a line.
const INLINE_MARKS_PATTERN = /[*_`~]+/g;
// A link shows its label.
const LINK_PATTERN = /!?\[([^\]]*)\]\([^)]*\)/g;

function cutLine(text: string): string {
    const characters = Array.from(text);

    if (characters.length <= MAX_NOTICE_LINE_CHARACTERS) {
        return text;
    }

    const kept = characters.slice(0, MAX_NOTICE_LINE_CHARACTERS - 1)
        .join('')
        .trimEnd();

    return `${kept}…`;
}

// One plain line for a notification: spaces collapsed and cut to the limit. Undefined when nothing is left.
function toNoticeLine(text: string): string | undefined {
    const line = text.replace(/\s+/g, ' ')
        .trim();

    return line === '' ? undefined : cutLine(line);
}

// The first line of a reply that has words, without its Markdown marks.
function firstReplyLine(reply: string): string | undefined {
    const plainLines = reply.split('\n')
        .map(line => line.trim()
            .replace(LEADING_MARKS_PATTERN, '')
            .replace(LINK_PATTERN, '$1')
            .replace(INLINE_MARKS_PATTERN, '')
            .trim())
        .filter(line => /[\p{L}\p{N}]/u.test(line));
    const firstLine = plainLines[0];

    return firstLine === undefined ? undefined : toNoticeLine(firstLine);
}

export { MAX_NOTICE_LINE_CHARACTERS, firstReplyLine, toNoticeLine };
