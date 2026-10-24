import { createHash } from 'node:crypto';

import type { BotSecret, BotSecrets } from '../secrets/BotSecrets.ts';
import { readJsonBody, readText } from './oauthDiscovery.ts';
import type { FetchFunction } from './probeAppServer.ts';

// The sign-in of a connected server, kept in the vault as one secret. It holds the access token, the refresh token
// and what the refresh needs. Only the app proxy reads it, and only to put the access token on a request.

interface StoredOAuth {
    accessToken: string;
    refreshToken: string | undefined;
    // When the access token stops working, in milliseconds. Undefined when the server did not say.
    expiresAt: number | undefined;
    clientId: string;
    clientSecret: string | undefined;
    tokenEndpoint: string;
}

interface TokenGrant {
    accessToken: string;
    refreshToken: string | undefined;
    expiresAt: number | undefined;
}

type OAuthSecrets = Pick<BotSecrets, 'read' | 'save'>;

interface AppOAuthTokensDeps {
    secrets: OAuthSecrets;
    // Sends a request after the address was checked. The token endpoint is one of those addresses.
    fetchFunction: FetchFunction;
    now?: (() => number) | undefined;
}

const OAUTH_SECRET_PREFIX = 'OAUTH_';
const SECRET_NAME_MAX = 32;
const NAME_HASH_LENGTH = 8;
const REFRESH_MARGIN_MS = 60 * 1000;
const TOKEN_TIMEOUT_MS = 15 * 1000;
const MS_PER_SECOND = 1000;
const SIGN_IN_ENDED_MESSAGE = 'The sign-in of this server ended. Connect the app again.';

// A short hash of the name ends the secret name, so two long names that start alike never share a secret.
function oauthSecretName(appName: string): string {
    const nameHash = createHash('sha256')
        .update(appName)
        .digest('hex')
        .slice(0, NAME_HASH_LENGTH)
        .toUpperCase();
    const readableLength = SECRET_NAME_MAX - OAUTH_SECRET_PREFIX.length - NAME_HASH_LENGTH - 1;
    const readableName = appName.toUpperCase()
        .replaceAll('-', '_')
        .slice(0, readableLength);

    return `${OAUTH_SECRET_PREFIX}${readableName}_${nameHash}`;
}

function isOAuthSecretName(secretName: string): boolean {
    return secretName.startsWith(OAUTH_SECRET_PREFIX);
}

function readStored(value: string): StoredOAuth | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(value);
    } catch {
        return undefined;
    }

    if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
    }

    const fields = parsed as Record<string, unknown>;
    const accessToken = readText(fields, 'accessToken');
    const clientId = readText(fields, 'clientId');
    const tokenEndpoint = readText(fields, 'tokenEndpoint');
    const expiresAt = fields['expiresAt'];

    if (accessToken === undefined || clientId === undefined || tokenEndpoint === undefined) {
        return undefined;
    }

    return {
        accessToken,
        refreshToken: readText(fields, 'refreshToken'),
        expiresAt: typeof expiresAt === 'number' ? expiresAt : undefined,
        clientId,
        clientSecret: readText(fields, 'clientSecret'),
        tokenEndpoint,
    };
}

// Asks the token endpoint, for a first grant from a code or for a new one from a refresh token.
async function requestGrant(
    fetchFunction: FetchFunction,
    tokenEndpoint: string,
    form: Record<string, string>,
    now: number,
): Promise<TokenGrant | undefined> {
    try {
        const response = await fetchFunction(tokenEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
            body: new URLSearchParams(form)
                .toString(),
            redirect: 'manual',
            signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        });

        if (!response.ok) {
            await response.body?.cancel();

            return undefined;
        }

        const body = await readJsonBody(response);
        const accessToken = body === undefined ? undefined : readText(body, 'access_token');
        const rawLifetime = body?.['expires_in'];
        const lifetime = typeof rawLifetime === 'string' && rawLifetime !== '' ? Number(rawLifetime) : rawLifetime;

        if (body === undefined || accessToken === undefined) {
            return undefined;
        }

        return {
            accessToken,
            refreshToken: readText(body, 'refresh_token'),
            expiresAt: typeof lifetime === 'number' && Number.isFinite(lifetime) ? now + (lifetime * MS_PER_SECOND) : undefined,
        };
    } catch {
        return undefined;
    }
}

// Gives the proxy the access token of a sign-in, and gets a new one first when it is about to stop working.
class AppOAuthTokens {
    private readonly deps: AppOAuthTokensDeps;
    private readonly refreshing = new Map<string, Promise<StoredOAuth | undefined>>();

    constructor(deps: AppOAuthTokensDeps) {
        this.deps = deps;
    }

    // Undefined when the secret is not a sign-in of this kind, so the caller sends it as a plain token.
    async accessToken(botId: string, secretName: string, secret: BotSecret): Promise<string | undefined> {
        const stored = readStored(secret.value);

        if (stored === undefined) {
            return undefined;
        }

        const currentTime = this.now();
        const isExpiring = stored.expiresAt !== undefined && stored.expiresAt - currentTime < REFRESH_MARGIN_MS;

        if (!isExpiring) {
            return stored.accessToken;
        }

        const refreshed = await this.refresh(botId, secretName, secret.site, stored);

        if (refreshed !== undefined) {
            return refreshed.accessToken;
        }

        // A token that is about to end still works until it does, so a refresh that failed only matters after that.
        if (stored.expiresAt !== undefined && stored.expiresAt > currentTime) {
            return stored.accessToken;
        }

        throw new Error(SIGN_IN_ENDED_MESSAGE);
    }

    // Keeps a new sign-in in the vault, for the site of the server only.
    store(botId: string, secretName: string, site: string, sign: { grant: TokenGrant; clientId: string; clientSecret: string | undefined; tokenEndpoint: string }): void {
        const stored: StoredOAuth = {
            accessToken: sign.grant.accessToken,
            refreshToken: sign.grant.refreshToken,
            expiresAt: sign.grant.expiresAt,
            clientId: sign.clientId,
            clientSecret: sign.clientSecret,
            tokenEndpoint: sign.tokenEndpoint,
        };
        const value = JSON.stringify(stored);

        this.deps.secrets.save(botId, secretName, site, value);
    }

    // One refresh at a time for a sign-in, since a refresh token may work only once.
    private refresh(botId: string, secretName: string, site: string, stored: StoredOAuth): Promise<StoredOAuth | undefined> {
        const key = `${botId}:${secretName}:${site}:${stored.refreshToken ?? ''}`;
        const running = this.refreshing.get(key);

        if (running !== undefined) {
            return running;
        }

        const started = this.requestRefresh(botId, secretName, site, stored)
            .finally(() => {
                this.refreshing.delete(key);
            });

        this.refreshing.set(key, started);

        return started;
    }

    private async requestRefresh(botId: string, secretName: string, site: string, stored: StoredOAuth): Promise<StoredOAuth | undefined> {
        if (stored.refreshToken === undefined) {
            return undefined;
        }

        const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: stored.clientId };

        if (stored.clientSecret !== undefined) {
            form['client_secret'] = stored.clientSecret;
        }

        const requestTime = this.now();
        const grant = await requestGrant(this.deps.fetchFunction, stored.tokenEndpoint, form, requestTime);

        if (grant === undefined) {
            return undefined;
        }

        // Some servers do not send a new refresh token, and then the old one stays good.
        const nextGrant: TokenGrant = { ...grant, refreshToken: grant.refreshToken ?? stored.refreshToken };

        // The sign-in may have been replaced while the request ran, and then the new one must stay.
        const current = this.deps.secrets.read(botId, secretName);
        const currentStored = current === undefined ? undefined : readStored(current.value);

        if (current?.site === site && currentStored?.refreshToken === stored.refreshToken) {
            this.store(botId, secretName, site, { grant: nextGrant, clientId: stored.clientId, clientSecret: stored.clientSecret, tokenEndpoint: stored.tokenEndpoint });
        }

        return { ...stored, ...nextGrant };
    }

    private now(): number {
        return this.deps.now === undefined ? Date.now() : this.deps.now();
    }
}

export { AppOAuthTokens, SIGN_IN_ENDED_MESSAGE, isOAuthSecretName, oauthSecretName, requestGrant };
export type { AppOAuthTokensDeps, TokenGrant };
