// Mark the matched words in a snippet. Control characters, so no message text can be taken for a mark by accident.
const SNIPPET_MARK_START = '\u0002';
const SNIPPET_MARK_END = '\u0003';

interface MessageSearchHit {
    botId: string;
    messageId: string;
    sequence: number;
    createdAt: number;
    snippet: string;
}

export { SNIPPET_MARK_END, SNIPPET_MARK_START };
export type { MessageSearchHit };
