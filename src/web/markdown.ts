import { Marked } from 'marked';
import type { Tokens } from 'marked';

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const MAX_CACHED_HTML = 500;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_LINE = /^(?:[-*+]|\d{1,9}[.)])\s/;

interface DraftScan {
    blocks: string[];
    current: string[];
    afterBlank: boolean;
    hasList: boolean;
    // The marker that opened the code fence the scan is inside.
    openFence: string | undefined;
}

const htmlCache = new Map<string, string>();

function escapeHtml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function isSafeUrl(url: string): boolean {
    try {
        const parsedUrl = new URL(url);

        return SAFE_PROTOCOLS.has(parsedUrl.protocol);
    } catch {
        return false;
    }
}

// Raw HTML from a message is shown as text, never rendered. Links with an
// unsafe scheme such as javascript: become plain text.
const safeRenderer = {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text);
    },
    image({ text }: Tokens.Image): string {
        return escapeHtml(text);
    },
    link({ href, text }: Tokens.Link): string {
        const escapedText = escapeHtml(text);

        if (!isSafeUrl(href)) {
            return escapedText;
        }

        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapedText}</a>`;
    },
};

const markdownParser = new Marked({ gfm: true, breaks: true, renderer: safeRenderer });

function renderDraftMarkdown(markdown: string): string {
    return markdownParser.parse(markdown, { async: false });
}

// Switching back to a chat shows the same messages again, so their html is kept.
function renderMarkdown(markdown: string): string {
    const cached = htmlCache.get(markdown);

    if (cached !== undefined) {
        return cached;
    }

    const html = renderDraftMarkdown(markdown);

    htmlCache.set(markdown, html);

    if (htmlCache.size > MAX_CACHED_HTML) {
        const oldest = htmlCache.keys();

        htmlCache.delete(oldest.next().value ?? '');
    }

    return html;
}

// Cuts a streamed reply into blocks, so a finished block never parses again. A cut happens at a blank line, outside a
// code fence, once the next line is complete and cannot continue the block before it. A reference link defined in a
// later block stays as text until the stored message replaces the draft.
function splitDraftMarkdown(markdown: string): string[] {
    const lines = markdown.split('\n');
    const lastLine = lines.pop() ?? '';
    const scan = lines.reduce<DraftScan>((state, line) => {
        const fence = FENCE_LINE.exec(line);

        if (state.openFence !== undefined) {
            const closes = fence?.[1]?.startsWith(state.openFence) === true && fence[2]?.trim() === '';

            state.current.push(line);
            state.openFence = closes ? undefined : state.openFence;

            return state;
        }

        const isListLine = LIST_LINE.test(line);
        const canContinue = /^\s/.test(line) || (isListLine && state.hasList);

        if (state.afterBlank && line !== '' && !canContinue && state.current.length > 0) {
            const block = state.current.join('\n');

            state.blocks.push(block);
            state.current = [];
            state.hasList = false;
        }

        state.current.push(line);
        state.afterBlank = line.trim() === '';
        state.hasList ||= isListLine;
        state.openFence = fence?.[1];

        return state;
    }, { blocks: [], current: [], afterBlank: false, hasList: false, openFence: undefined });

    scan.current.push(lastLine);
    const openBlock = scan.current.join('\n');

    scan.blocks.push(openBlock);

    return scan.blocks;
}

export { isSafeUrl, renderDraftMarkdown, renderMarkdown, splitDraftMarkdown };
