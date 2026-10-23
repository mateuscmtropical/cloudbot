import { renderMascot } from './mascotSvg.ts';
import { escapeHtml, renderPage } from './renderPage.ts';
import type { RenderedPage } from './renderPage.ts';

interface LoginPageOptions {
    name: string;
    error?: string | undefined;
    extras?: LoginPageExtras | undefined;
}

interface LoginPageExtras {
    html: string;
    script: string;
}

interface ChangePasswordPageOptions {
    error?: string | undefined;
}

const LOADING_SCRIPT = `const checkStatus = async () => { try { const response = await fetch('/__hub/status', { cache: 'no-store' }); const answer = await response.json(); if (answer.status === 'running') { location.reload(); return; } if (answer.status === 'busy') { location.replace('/'); return; } } catch {} setTimeout(checkStatus, 2000); }; setTimeout(checkStatus, 2000);`;
const BUSY_SCRIPT = `setTimeout(() => location.reload(), 2000);`;

function renderApexPage(): RenderedPage {
    const mascot = renderMascot('idle');
    const body = `<main>${mascot}<h1>CloudBot</h1><p>Enter your name to open your CloudBot.</p><form method="get" action="/__hub/redirect"><label for="person-name">Your name</label><input id="person-name" name="name" type="text" autocomplete="username" minlength="2" maxlength="30" required><button type="submit">Continue</button></form></main>`;

    return renderPage({ title: 'CloudBot', body });
}

function renderLoginPage(options: LoginPageOptions): RenderedPage {
    const name = escapeHtml(options.name);
    const error = options.error === undefined ? '' : escapeHtml(options.error);
    const mascot = renderMascot('idle');
    const extrasHtml = options.extras?.html ?? '';
    const body = `<main>${mascot}<h1>CloudBot</h1><p>Welcome, ${name}. Sign in to open your CloudBot.</p><form method="post" action="/__hub/login"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><p role="alert" aria-live="polite">${error}</p><button type="submit">Sign in</button></form>${extrasHtml}</main>`;
    const scripts = options.extras === undefined || options.extras.script === '' ? [] : [options.extras.script];

    return renderPage({ title: 'Sign in', body, scripts });
}

function renderChangePasswordPage(options: ChangePasswordPageOptions = {}): RenderedPage {
    const error = options.error === undefined ? '' : escapeHtml(options.error);
    const mascot = renderMascot('idle');
    const body = `<main>${mascot}<h1>Choose a new password</h1><p>Use at least 10 characters. Only you will know it.</p><form method="post" action="/__hub/password"><label for="new-password">New password</label><input id="new-password" name="password" type="password" autocomplete="new-password" minlength="10" required autofocus><label for="confirm-password">Confirm new password</label><input id="confirm-password" name="confirmation" type="password" autocomplete="new-password" minlength="10" required><p role="alert" aria-live="polite">${error}</p><button type="submit">Save password</button></form></main>`;

    return renderPage({ title: 'Change password', body });
}

function renderLoadingPage(): RenderedPage {
    const mascot = renderMascot('thinking')
        .replace('class="mascot"', 'class="mascot floating"');
    const body = `<main>${mascot}<h1>Starting your environment</h1><p>This takes about a minute. This page opens your CloudBot when it is ready.</p></main>`;

    return renderPage({ title: 'Starting your environment', body, scripts: [LOADING_SCRIPT] });
}

function renderBusyPage(): RenderedPage {
    const mascot = renderMascot('sleepy');
    const body = `<main>${mascot}<h1>The server is busy right now</h1><p>Trying again in a moment.</p></main>`;

    return renderPage({ title: 'Server busy', body, scripts: [BUSY_SCRIPT] });
}

function renderNotAvailablePage(): RenderedPage {
    const mascot = renderMascot('sleepy');
    const body = `<main>${mascot}<h1>Not available</h1><p>This address is not available.</p></main>`;

    return renderPage({ title: 'Not available', body });
}

function renderUpstreamErrorPage(): RenderedPage {
    const mascot = renderMascot('error');
    const body = `<main>${mascot}<h1>CloudBot is unavailable</h1><p>Please try again in a moment.</p></main>`;

    return renderPage({ title: 'CloudBot is unavailable', body });
}
export { renderApexPage, renderBusyPage, renderChangePasswordPage, renderLoadingPage, renderLoginPage, renderNotAvailablePage, renderUpstreamErrorPage };
export type { ChangePasswordPageOptions, LoginPageExtras, LoginPageOptions };
