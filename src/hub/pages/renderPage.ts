import { randomBytes } from 'node:crypto';

interface PageOptions {
    title: string;
    body: string;
    scripts?: readonly string[];
}

interface RenderedPage {
    html: string;
    csp: string;
}

interface HtmlEscapeMap {
    [character: string]: string;
}

const PAGE_CSS = `
    :root { color-scheme: dark; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #ececf1; background: #1b1b1f; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; min-height: 100dvh; margin: 0; display: grid; place-items: center; padding: 16px; background: #1b1b1f; color: #ececf1; }
    main { width: min(420px, 100%); padding: 32px 24px; border-radius: 18px; background: #2a2a30; }
    h1 { margin: 0 0 8px; font-size: 1.5rem; }
    p { margin: 0; color: #9a9aa6; line-height: 1.5; }
    form { display: grid; gap: 14px; margin-top: 24px; }
    label { font-weight: 600; }
    input { width: 100%; min-height: 44px; padding: 10px 14px; border: 1px solid #52525d; border-radius: 10px; background: #1b1b1f; color: #ececf1; }
    input:focus-visible, button:focus-visible { outline: 3px solid #2f80ed; outline-offset: 3px; }
    button { min-height: 44px; padding: 10px 18px; border: 0; border-radius: 999px; background: #2f80ed; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    [role='alert'] { min-height: 1.5em; color: #ff8589; }
    .cloud { display: block; width: 58px; height: 42px; margin-bottom: 22px; }
    @media (max-width: 420px) { main { padding: 26px 20px; } }
`;

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => {
        const escaped: HtmlEscapeMap = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            '\'': '&#39;',
        };

        return escaped[character] ?? character;
    });
}

function renderPage(options: PageOptions): RenderedPage {
    const nonceBytes = randomBytes(18);
    const nonce = nonceBytes.toString('base64url');
    const scripts = (options.scripts ?? []).map(script => `<script nonce="${nonce}">${script}</script>`)
        .join('');
    const title = escapeHtml(options.title);
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; connect-src 'self'`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${PAGE_CSS}</style></head><body>${options.body}${scripts}</body></html>`;

    return { html, csp };
}

export { escapeHtml, renderPage };
export type { PageOptions, RenderedPage };
