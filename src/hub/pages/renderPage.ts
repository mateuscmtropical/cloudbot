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
    :root { color-scheme: dark; --background: #1b1b1f; --surface: #2a2a30; --raised: #33333b; --line: #3a3a44; --text: #ececf1; --muted: #9a9aa6; --accent: #2f80ed; --danger: #ff8589; --hover: color-mix(in srgb, #ececf1 12%, transparent); font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: var(--text); background: var(--background); }
    * { box-sizing: border-box; }
    body { min-height: 100vh; min-height: 100dvh; margin: 0; display: grid; place-items: center; padding: 16px; background: var(--background); color: var(--text); }
    main { display: flex; flex-direction: column; align-items: center; gap: 16px; width: min(420px, 100%); padding: 40px 32px 36px; border-radius: 18px; background: var(--surface); text-align: center; }
    h1 { margin: 0; font-size: 1.5rem; }
    p { margin: 0; color: var(--muted); line-height: 1.5; }
    a { color: var(--accent); }
    form { display: flex; flex-direction: column; gap: 8px; width: 100%; margin-top: 8px; text-align: left; }
    label { font-weight: 600; }
    input { width: 100%; min-height: 46px; padding: 10px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--background); color: var(--text); font: inherit; }
    input:focus { border-color: var(--accent); }
    input:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
    button { width: 100%; min-height: 46px; padding: 10px 20px; border: 1px solid var(--accent); border-radius: 999px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    button.secondary { border-color: var(--line); background: var(--raised); color: var(--text); }
    button:disabled { cursor: default; opacity: 0.5; }
    @media (hover: hover) { button:not(:disabled):hover { background-image: linear-gradient(var(--hover), var(--hover)); } }
    [role='alert'], [role='status'] { min-height: 1.4em; margin: 0; color: var(--danger); font-size: 0.95rem; }
    [hidden] { display: none !important; }
    .stack { display: flex; flex-direction: column; gap: 12px; width: 100%; }
    .actions { display: flex; flex-direction: column; gap: 10px; width: 100%; }
    .divider { display: flex; align-items: center; gap: 12px; width: 100%; color: var(--muted); font-size: 0.85rem; }
    .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--line); }
    .mascot { display: block; width: 96px; height: 96px; margin-bottom: 4px; }
    .mascot svg { width: 100%; height: 100%; }
    .eyes { transform-box: fill-box; transform-origin: center; animation: blink 5s infinite; }
    .mascot.floating { animation: float 2.4s ease-in-out infinite; }
    .list { display: flex; flex-direction: column; gap: 8px; width: 100%; margin: 0; padding: 0; list-style: none; text-align: left; }
    .row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; border-radius: 12px; background: var(--raised); }
    .row small { display: block; color: var(--muted); }
    .row button { width: auto; min-height: 38px; padding: 6px 16px; }
    @keyframes blink { 0%, 94%, 100% { transform: scaleY(1); } 97% { transform: scaleY(0.1); } }
    @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
    @media (prefers-reduced-motion: reduce) { .eyes, .mascot.floating { animation: none; } }
    @media (max-width: 420px) { main { padding: 32px 20px 28px; } }
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
