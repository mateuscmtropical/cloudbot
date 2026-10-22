// The browser side of passkeys. The server makes the options and checks the answers. The browser's own JSON helpers turn
// them into WebAuthn calls, so no library is needed.

type PasskeyResult = 'done' | 'unsupported' | 'cancelled' | 'failed';

const JSON_HEADERS = { 'content-type': 'application/json' };

function isSupported(): boolean {
    return typeof PublicKeyCredential !== 'undefined'
        && typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function'
        && typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function';
}

async function postJson(path: string, body: unknown): Promise<Response> {
    const text = JSON.stringify(body);

    return fetch(path, { method: 'POST', headers: JSON_HEADERS, body: text });
}

async function readOptions(path: string): Promise<unknown> {
    const response = await postJson(path, {});

    if (!response.ok) {
        throw new Error('The server did not give passkey options.');
    }

    return response.json();
}

// The browser rejects with NotAllowedError when the owner closes its prompt.
function toFailure(error: unknown): PasskeyResult {
    return error instanceof DOMException && error.name === 'NotAllowedError' ? 'cancelled' : 'failed';
}

// A name for the list in the chat, such as the system of this device.
function deviceName(): string {
    const platform = navigator.platform.trim();

    return platform === '' ? 'Passkey' : platform;
}

// Makes a passkey on this device for the signed-in owner, and saves it on the server.
async function addPasskey(): Promise<PasskeyResult> {
    if (!isSupported()) {
        return 'unsupported';
    }

    try {
        const optionsJson = await readOptions('/api/passkeys/register/options');
        const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(optionsJson as PublicKeyCredentialCreationOptionsJSON);
        const credential = await navigator.credentials.create({ publicKey }) as PublicKeyCredential | null;

        if (credential === null) {
            return 'cancelled';
        }

        const answer = credential.toJSON();
        const name = deviceName();
        const response = await postJson('/api/passkeys/register/verify', { response: answer, name });

        return response.ok ? 'done' : 'failed';
    } catch (error: unknown) {
        return toFailure(error);
    }
}

async function removePasskey(passkeyId: string): Promise<boolean> {
    const encodedId = encodeURIComponent(passkeyId);
    const response = await fetch(`/api/passkeys/${encodedId}`, { method: 'DELETE' });

    // A passkey that is already gone is what the owner asked for.
    return response.ok || response.status === 404;
}

// Signs in with a passkey of this device. The server sets the session cookie when it checks the answer.
async function signInWithPasskey(): Promise<PasskeyResult> {
    if (!isSupported()) {
        return 'unsupported';
    }

    try {
        const optionsJson = await readOptions('/auth/passkey/options');
        const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(optionsJson as PublicKeyCredentialRequestOptionsJSON);
        const credential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential | null;

        if (credential === null) {
            return 'cancelled';
        }

        const answer = credential.toJSON();
        const response = await postJson('/auth/passkey/verify', answer);

        return response.ok ? 'done' : 'failed';
    } catch (error: unknown) {
        return toFailure(error);
    }
}

function describePasskeyResult(result: PasskeyResult): string | undefined {
    if (result === 'unsupported') {
        return 'This browser cannot use passkeys.';
    }

    if (result === 'failed') {
        return 'The passkey did not work. Try again.';
    }

    return undefined;
}

export { addPasskey, describePasskeyResult, removePasskey, signInWithPasskey };
export type { PasskeyResult };
