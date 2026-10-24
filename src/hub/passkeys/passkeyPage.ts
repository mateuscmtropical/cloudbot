import type { HubPasskeyStore } from './HubPasskeyStore.ts';
import type { HubPasskeySummary } from './HubPasskeyService.ts';
import type { Context } from 'hono';
import { renderMascot } from '../pages/mascotSvg.ts';

interface PasskeyLoginExtras {
    html: string;
    script: string;
}

interface PasskeyOfferPage {
    body: string;
    script: string;
}

interface PasskeyManagementPage {
    body: string;
    script: string;
}

interface AfterLoginOptions {
    store: Pick<HubPasskeyStore, 'list'>;
    cookiesOf: (name: string, context: Context) => string | undefined;
}

const PASSKEY_OFFER_COOKIE = 'cloudbot_passkey_offer';
const PASSKEY_OFFER_PATH = '/__hub/passkey/offer';
const PASSKEY_OFFER_SKIP_AGE_SECONDS = 180 * 24 * 60 * 60;

const BROWSER_WEBAUTHN_HELPERS = [
    'const toBase64Url = function (buffer) {',
    '    const bytes = new Uint8Array(buffer);',
    '    let binary = "";',
    '    bytes.forEach(function (byte) { binary += String.fromCharCode(byte); });',
    '    return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");',
    '};',
    'const fromBase64Url = function (value) {',
    '    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");',
    '    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);',
    '    const binary = atob(padded);',
    '    const bytes = new Uint8Array(binary.length);',
    '    Array.from(binary).forEach(function (character, index) { bytes[index] = character.charCodeAt(0); });',
    '    return bytes;',
    '};',
    'const jsonResponse = async function (response) {',
    '    if (response.ok) { return response.status === 204 ? {} : await response.json(); }',
    '    const body = await response.json().catch(function () { return {}; });',
    '    throw new Error(body.error || "The passkey request failed. Try again.");',
    '};',
    'const postJson = async function (path, body) {',
    '    const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });',
    '    return jsonResponse(response);',
    '};',
    'const serializeCredential = function (credential, isRegistration) {',
    '    const credentialResponse = credential.response;',
    '    const response = isRegistration ? {',
    '        clientDataJSON: toBase64Url(credentialResponse.clientDataJSON),',
    '        attestationObject: toBase64Url(credentialResponse.attestationObject),',
    '        transports: typeof credentialResponse.getTransports === "function" ? credentialResponse.getTransports() : []',
    '    } : {',
    '        clientDataJSON: toBase64Url(credentialResponse.clientDataJSON),',
    '        authenticatorData: toBase64Url(credentialResponse.authenticatorData),',
    '        signature: toBase64Url(credentialResponse.signature),',
    '        userHandle: credentialResponse.userHandle ? toBase64Url(credentialResponse.userHandle) : null',
    '    };',
    '    return { id: credential.id, rawId: toBase64Url(credential.rawId), type: credential.type, response: response, clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment };',
    '};',
    'const platformAuthenticatorAvailable = function () {',
    '    return window.PublicKeyCredential && typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"',
    '        ? PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()',
    '        : Promise.resolve(false);',
    '};',
].join('\n');

const PASSKEY_NOT_SET_UP_MESSAGE = 'Fingerprint or face sign-in was canceled or is not set up on this device. Sign in with your password, then turn it on from Account.';

const LOGIN_SCRIPT = BROWSER_WEBAUTHN_HELPERS + '\n' + [
    '(function () {',
    '    const button = document.getElementById("hub-passkey-login");',
    '    const problem = document.getElementById("hub-passkey-login-problem");',
    '    if (!button || !problem) { return; }',
    '    platformAuthenticatorAvailable().then(function (available) { if (available) { document.getElementById("hub-passkey-login-block").hidden = false; } }).catch(function () {});',
    '    button.addEventListener("click", async function () {',
    '        button.disabled = true;',
    '        problem.textContent = "";',
    '        try {',
    '            const options = await postJson("/__hub/passkey/login/options");',
    '            options.challenge = fromBase64Url(options.challenge);',
    '            if (Array.isArray(options.allowCredentials)) { options.allowCredentials = options.allowCredentials.map(function (item) { return Object.assign({}, item, { id: fromBase64Url(item.id) }); }); }',
    '            const credential = await navigator.credentials.get({ publicKey: options });',
    '            if (!credential) { throw new Error("No passkey was selected."); }',
    '            await postJson("/__hub/passkey/login/verify", serializeCredential(credential, false));',
    '            window.location.assign("/");',
    '        } catch (error) {',
    // The browser gives NotAllowedError both when the person cancels and when this device has no passkey for the site.
    '            const notSetUp = error instanceof Error && error.name === "NotAllowedError";',
    '            problem.textContent = notSetUp ? "' + PASSKEY_NOT_SET_UP_MESSAGE + '" : error instanceof Error ? error.message : "The passkey could not be checked. Try again.";',
    '            button.disabled = false;',
    '        }',
    '    });',
    '}());',
].join('\n');

const OFFER_SCRIPT = BROWSER_WEBAUTHN_HELPERS + '\n' + [
    '(function () {',
    '    const enableButton = document.getElementById("hub-passkey-enable");',
    '    const skipButton = document.getElementById("hub-passkey-skip");',
    '    const problem = document.getElementById("hub-passkey-offer-problem");',
    '    if (!enableButton || !skipButton || !problem) { return; }',
    '    const goHome = function () { window.location.replace("/"); };',
    '    const skipOffer = function () {',
    '        const secure = window.location.protocol === "https:" ? "; Secure" : "";',
    '        document.cookie = "' + PASSKEY_OFFER_COOKIE + '=skip; Max-Age=' + String(PASSKEY_OFFER_SKIP_AGE_SECONDS) + '; Path=/; SameSite=Lax" + secure;',
    '        goHome();',
    '    };',
    '    platformAuthenticatorAvailable().then(function (available) { if (!available) { goHome(); } }).catch(goHome);',
    '    skipButton.addEventListener("click", skipOffer);',
    '    enableButton.addEventListener("click", async function () {',
    '        enableButton.disabled = true;',
    '        skipButton.disabled = true;',
    '        problem.textContent = "";',
    '        try {',
    '            const options = await postJson("/__hub/passkey/register/options");',
    '            options.challenge = fromBase64Url(options.challenge);',
    '            options.user = Object.assign({}, options.user, { id: fromBase64Url(options.user.id) });',
    '            if (Array.isArray(options.excludeCredentials)) { options.excludeCredentials = options.excludeCredentials.map(function (item) { return Object.assign({}, item, { id: fromBase64Url(item.id) }); }); }',
    '            const credential = await navigator.credentials.create({ publicKey: options });',
    '            if (!credential) { throw new Error("No passkey was created."); }',
    '            await postJson("/__hub/passkey/register/verify", { response: serializeCredential(credential, true), label: "This device" });',
    '            goHome();',
    '        } catch (error) {',
    '            problem.textContent = error instanceof Error ? error.message : "The passkey could not be added. Try again.";',
    '            enableButton.disabled = false;',
    '            skipButton.disabled = false;',
    '        }',
    '    });',
    '}());',
].join('\n');

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function passkeyLoginExtras(): PasskeyLoginExtras {
    const html = '<div id="hub-passkey-login-block" class="stack" hidden><div class="divider" role="presentation">or</div>'
        + '<div class="actions"><button id="hub-passkey-login" class="secondary" type="button">Sign in with fingerprint or face</button></div>'
        + '<p id="hub-passkey-login-problem" role="status" aria-live="polite"></p></div>';

    return { html, script: LOGIN_SCRIPT };
}

function renderOfferPage(): PasskeyOfferPage {
    const body = '<main aria-labelledby="hub-passkey-title">' + renderMascot('idle')
        + '<h1 id="hub-passkey-title">Turn on fingerprint or face for this device?</h1>'
        + '<p>Use this device’s screen lock to sign in next time.</p>'
        + '<div class="actions"><button id="hub-passkey-enable" type="button">Turn on</button>'
        + '<button id="hub-passkey-skip" class="secondary" type="button">Not now</button></div>'
        + '<p id="hub-passkey-offer-problem" role="status" aria-live="polite"></p>'
        + '</main>';

    return { body, script: OFFER_SCRIPT };
}

function renderPasskeysPage(passkeys: HubPasskeySummary[]): PasskeyManagementPage {
    const rows = passkeys.map((passkey) => {
        const label = escapeHtml(passkey.label);
        const id = escapeHtml(passkey.id);
        const createdAt = new Date(passkey.createdAt)
            .toLocaleDateString('en', { dateStyle: 'medium' });

        return '<li class="row" data-passkey-row="' + id + '"><span>' + label + ' <small>Added ' + escapeHtml(createdAt) + '</small></span>'
            + '<button class="secondary" type="button" data-passkey-id="' + id + '" aria-label="Remove ' + label + '">Remove</button></li>';
    });
    const emptyMessage = passkeys.length === 0 ? '<p id="hub-passkey-empty">No passkeys have been added.</p>' : '';
    const body = '<main aria-labelledby="hub-passkeys-title">' + renderMascot('idle')
        + '<h1 id="hub-passkeys-title">Your passkeys</h1><p>Passkeys are stored for this address only.</p>'
        + emptyMessage + '<ul class="list">' + rows.join('') + '</ul><p id="hub-passkeys-problem" role="status" aria-live="polite"></p>'
        + '<a href="/">Back to CloudBot</a></main>';

    const script = [
        '(function () {',
        '    const problem = document.getElementById("hub-passkeys-problem");',
        '    document.querySelectorAll("[data-passkey-id]").forEach(function (button) {',
        '        button.addEventListener("click", async function () {',
        '            button.disabled = true;',
        '            problem.textContent = "";',
        '            try {',
        '                const response = await fetch("/__hub/passkey/" + encodeURIComponent(button.dataset.passkeyId), { method: "DELETE", credentials: "same-origin" });',
        '                if (!response.ok) { throw new Error("The passkey could not be removed. Try again."); }',
        '                const row = button.closest("[data-passkey-row]");',
        '                if (row) { row.remove(); }',
        '                if (!document.querySelector("[data-passkey-row]")) {',
        '                    const empty = document.createElement("p");',
        '                    empty.id = "hub-passkey-empty";',
        '                    empty.textContent = "No passkeys have been added.";',
        '                    document.querySelector(".list").before(empty);',
        '                }',
        '            } catch (error) {',
        '                problem.textContent = error instanceof Error ? error.message : "The passkey could not be removed. Try again.";',
        '                button.disabled = false;',
        '            }',
        '        });',
        '    });',
        '}());',
    ].join('\n');

    return { body, script };
}

function shouldOfferPasskey(personName: string, store: Pick<HubPasskeyStore, 'list'>, cookieValue: string | undefined): boolean {
    return cookieValue !== 'skip' && store.list(personName).length === 0;
}

function createAfterLogin(options: AfterLoginOptions): (name: string, context: Context) => string | undefined {
    return (name, context) => {
        const cookieValue = options.cookiesOf(name, context);

        return shouldOfferPasskey(name, options.store, cookieValue) ? PASSKEY_OFFER_PATH : undefined;
    };
}

export { PASSKEY_OFFER_COOKIE, PASSKEY_OFFER_PATH, PASSKEY_OFFER_SKIP_AGE_SECONDS, createAfterLogin, passkeyLoginExtras, renderOfferPage, renderPasskeysPage, shouldOfferPasskey };
export type { AfterLoginOptions, PasskeyLoginExtras, PasskeyManagementPage, PasskeyOfferPage };
