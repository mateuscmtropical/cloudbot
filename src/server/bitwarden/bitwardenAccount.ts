import { DEFAULT_BITWARDEN_SERVER_URL } from '../../shared/bitwarden.ts';
import type { BotSecrets } from '../secrets/BotSecrets.ts';
import type { BitwardenAccount } from './BitwardenCli.ts';

// The owner's Bitwarden sign-in, kept in the vault as one secret per bot. The BITWARDEN_ prefix keeps it away from the
// model, which cannot type it, send it to an app or give it to a script. Only BitwardenVault reads it.
type BitwardenAccountSecrets = Pick<BotSecrets, 'read' | 'save' | 'remove'>;

interface BitwardenAccountInput {
    serverUrl?: unknown;
    clientId?: unknown;
    clientSecret?: unknown;
    masterPassword?: unknown;
}

type BitwardenAccountCheck
    = | { ok: true; account: BitwardenAccount }
        | { ok: false; error: string };

const BITWARDEN_ACCOUNT_SECRET_NAME = 'BITWARDEN_ACCOUNT';
const CLIENT_ID_PATTERN = /^user\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9]{16,64}$/;
const MAX_SERVER_URL_LENGTH = 200;
const MAX_MASTER_PASSWORD_LENGTH = 1024;
const INVALID_SERVER_URL = 'The server address must be a full https address, such as https://vault.bitwarden.com.';
const INVALID_CLIENT_ID = 'The client ID looks like user. followed by an id with dashes. Copy it from the API key in Bitwarden.';
const INVALID_CLIENT_SECRET = 'The client secret is 16 to 64 letters and digits. Copy it from the API key in Bitwarden.';
const INVALID_MASTER_PASSWORD = 'Enter the master password, up to 1024 characters.';

// The address without a trailing slash, so two spellings of the same server are one. Only https, with no user name,
// no query and no fragment, since the address goes to the Bitwarden CLI.
function normalizeServerUrl(rawUrl: string): string | undefined {
    if (rawUrl.length > MAX_SERVER_URL_LENGTH) {
        return undefined;
    }

    try {
        const parsed = new URL(rawUrl);
        const hasExtras = parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '';

        if (parsed.protocol !== 'https:' || hasExtras) {
            return undefined;
        }

        return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    } catch {
        return undefined;
    }
}

function readTrimmed(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function checkBitwardenAccount(input: BitwardenAccountInput): BitwardenAccountCheck {
    const rawServerUrl = readTrimmed(input.serverUrl);
    const serverUrl = normalizeServerUrl(rawServerUrl === '' ? DEFAULT_BITWARDEN_SERVER_URL : rawServerUrl);
    const clientId = readTrimmed(input.clientId);
    const clientSecret = readTrimmed(input.clientSecret);
    // The master password is kept exactly as typed, since a space can be part of it.
    const masterPassword = typeof input.masterPassword === 'string' ? input.masterPassword : '';

    if (serverUrl === undefined) {
        return { ok: false, error: INVALID_SERVER_URL };
    }

    if (!CLIENT_ID_PATTERN.test(clientId)) {
        return { ok: false, error: INVALID_CLIENT_ID };
    }

    if (!CLIENT_SECRET_PATTERN.test(clientSecret)) {
        return { ok: false, error: INVALID_CLIENT_SECRET };
    }

    // A null character cannot travel in an environment variable.
    const isPasswordUsable = masterPassword.length > 0 && masterPassword.length <= MAX_MASTER_PASSWORD_LENGTH && !masterPassword.includes('\0');

    if (!isPasswordUsable) {
        return { ok: false, error: INVALID_MASTER_PASSWORD };
    }

    return { ok: true, account: { serverUrl, clientId, clientSecret, masterPassword } };
}

function readStoredAccount(value: string): BitwardenAccount | undefined {
    try {
        const parsed: unknown = JSON.parse(value);

        if (typeof parsed !== 'object' || parsed === null) {
            return undefined;
        }

        const checked = checkBitwardenAccount({
            serverUrl: Reflect.get(parsed, 'serverUrl'),
            clientId: Reflect.get(parsed, 'clientId'),
            clientSecret: Reflect.get(parsed, 'clientSecret'),
            masterPassword: Reflect.get(parsed, 'masterPassword'),
        });

        return checked.ok ? checked.account : undefined;
    } catch {
        return undefined;
    }
}

class BitwardenAccountStore {
    private readonly secrets: BitwardenAccountSecrets;

    constructor(secrets: BitwardenAccountSecrets) {
        this.secrets = secrets;
    }

    read(botId: string): BitwardenAccount | undefined {
        const secret = this.secrets.read(botId, BITWARDEN_ACCOUNT_SECRET_NAME);

        return secret === undefined ? undefined : readStoredAccount(secret.value);
    }

    save(botId: string, account: BitwardenAccount): void {
        const value = JSON.stringify(account);
        const site = new URL(account.serverUrl).origin;

        this.secrets.save(botId, BITWARDEN_ACCOUNT_SECRET_NAME, site, value);
    }

    forget(botId: string): void {
        this.secrets.remove(botId, BITWARDEN_ACCOUNT_SECRET_NAME);
    }
}

export { BITWARDEN_ACCOUNT_SECRET_NAME, BitwardenAccountStore, checkBitwardenAccount, normalizeServerUrl };
export type { BitwardenAccountCheck, BitwardenAccountInput };
