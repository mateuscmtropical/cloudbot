import { Marked } from 'marked';
import type { Tokens } from 'marked';

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

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

function renderMarkdown(markdown: string): string {
    return markdownParser.parse(markdown, { async: false });
}

export { isSafeUrl, renderMarkdown };
