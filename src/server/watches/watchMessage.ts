import { OUTSIDE_DATA_LINE } from '../webhooks/webhookMessage.ts';

// The first line of every page watch message. The review context reads it to label the page text as outside data.
const WATCH_MESSAGE_PREFIX = 'Page watch ';
const MAX_DIFF_LINES = 20;
const MAX_DIFF_LINE_LENGTH = 200;
// The last text kept for the diff. The hash covers the whole text, so a longer page still gets a change check.
const MAX_STORED_TEXT_LENGTH = 20000;

function truncate(text: string, maxLength: number): string {
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function capStoredText(text: string): string {
    return truncate(text, MAX_STORED_TEXT_LENGTH);
}

// The page text comes from outside, so the message marks the diff as data and never as an instruction from the owner.
function buildWatchMessage(name: string, url: string, diffLines: string[]): string {
    const shownLines = diffLines.slice(0, MAX_DIFF_LINES)
        .map(line => truncate(line, MAX_DIFF_LINE_LENGTH));
    const hiddenCount = diffLines.length - shownLines.length;
    const diffText = shownLines.length === 0 ? 'The text changed, but no single line differs.' : shownLines.join('\n');
    const hiddenText = hiddenCount > 0 ? [`... and ${String(hiddenCount)} more changed lines.`] : [];

    return [
        `${WATCH_MESSAGE_PREFIX}"${name}" found a change on ${url}`,
        OUTSIDE_DATA_LINE,
        '',
        diffText,
        ...hiddenText,
    ].join('\n');
}

// Both lines must match, so an owner message that only starts with the prefix is not taken for a page watch.
function isWatchMessage(text: string): boolean {
    const [firstLine, secondLine] = text.split('\n');

    return firstLine?.startsWith(WATCH_MESSAGE_PREFIX) === true && secondLine === OUTSIDE_DATA_LINE;
}

export { MAX_STORED_TEXT_LENGTH, WATCH_MESSAGE_PREFIX, buildWatchMessage, capStoredText, isWatchMessage };
