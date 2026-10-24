import type { BotSecrets } from '../secrets/BotSecrets.ts';
import type { OAuthEndpoints } from './oauthDiscovery.ts';
import type { GoogleApp } from '../../shared/googleApps.ts';

// The Google Cloud OAuth client the owner made, kept in the vault as one secret. Google gives no dynamic
// registration, so this client is the only way to sign in. The OAUTH_ prefix keeps the secret away from
// the bot, which cannot type it into a page or read it back.

interface GoogleClient {
    clientId: string;
    clientSecret: string;
}

type GoogleClientSecrets = Pick<BotSecrets, 'read' | 'save' | 'remove'>;

const GOOGLE_CLIENT_SECRET_NAME = 'OAUTH_GOOGLE_CLIENT';
const GOOGLE_SITE = 'https://accounts.google.com';
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// The endpoints are fixed. There is no registration endpoint, so the field stays empty and is never used.
function googleEndpoints(app: GoogleApp): OAuthEndpoints {
    return {
        issuer: GOOGLE_ISSUER,
        authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
        tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
        registrationEndpoint: '',
        scopes: app.scopes,
    };
}

function readClient(value: string): GoogleClient | undefined {
    try {
        const parsed: unknown = JSON.parse(value);

        if (typeof parsed !== 'object' || parsed === null) {
            return undefined;
        }

        const clientId: unknown = Reflect.get(parsed, 'clientId');
        const clientSecret: unknown = Reflect.get(parsed, 'clientSecret');

        return typeof clientId === 'string' && typeof clientSecret === 'string' ? { clientId, clientSecret } : undefined;
    } catch {
        return undefined;
    }
}

class GoogleClientStore {
    private readonly secrets: GoogleClientSecrets;

    constructor(secrets: GoogleClientSecrets) {
        this.secrets = secrets;
    }

    read(botId: string): GoogleClient | undefined {
        const secret = this.secrets.read(botId, GOOGLE_CLIENT_SECRET_NAME);

        return secret?.site === GOOGLE_SITE ? readClient(secret.value) : undefined;
    }

    save(botId: string, client: GoogleClient): void {
        const value = JSON.stringify(client);

        this.secrets.save(botId, GOOGLE_CLIENT_SECRET_NAME, GOOGLE_SITE, value);
    }

    forget(botId: string): void {
        this.secrets.remove(botId, GOOGLE_CLIENT_SECRET_NAME);
    }
}

export { GOOGLE_CLIENT_SECRET_NAME, GOOGLE_SITE, GoogleClientStore, googleEndpoints };
export type { GoogleClient };
