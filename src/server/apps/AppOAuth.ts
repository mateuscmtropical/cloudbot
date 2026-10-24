import { createHash, randomBytes } from 'node:crypto';

import type { AppSignInStart } from '../../shared/connectedApps.ts';
import type { ConnectedApps } from './ConnectedApps.ts';
import { oauthSecretName, requestGrant } from './AppOAuthTokens.ts';
import type { AppOAuthTokens } from './AppOAuthTokens.ts';
import { discoverOAuth, registerClient } from './oauthDiscovery.ts';
import type { OAuthEndpoints, RegisteredClient } from './oauthDiscovery.ts';
import { parseAppUrl } from './appAddress.ts';
import type { FetchFunction } from './probeAppServer.ts';

// Connects a server with its own sign-in page, the way a browser app does. The owner is sent to the server's page,
// approves there, and comes back with a code. The code is traded for a token that goes into the vault. The token
// never reaches the page or the bot.

interface AppSignInFinish {
    outcome: 'connected' | 'failed';
    // Who the sign-in was for. Undefined when the sign-in was not found, so the page cannot say which app.
    botId: string | undefined;
    appName: string | undefined;
}

interface AppSignInReturn {
    state: string | undefined;
    code: string | undefined;
    error: string | undefined;
    issuer: string | undefined;
}

interface AppOAuthDeps {
    connectedApps: Pick<ConnectedApps, 'connect' | 'dropUnusedSecret'>;
    tokens: Pick<AppOAuthTokens, 'store'>;
    fetchFunction: FetchFunction;
    now?: (() => number) | undefined;
}

// A sign-in the owner has started and not yet finished. It lives in memory, so it ends with a restart.
interface PendingSignIn {
    botId: string;
    appName: string;
    serverUrl: string;
    redirectUri: string;
    codeVerifier: string;
    client: RegisteredClient;
    endpoints: OAuthEndpoints;
    expiresAt: number;
}

const PENDING_LIFETIME_MS = 10 * 60 * 1000;
const MAX_PENDING = 100;
const RANDOM_BYTES = 32;
const FAILED_START = 'The app did not accept the sign-in. Try again later.';

function randomToken(): string {
    return randomBytes(RANDOM_BYTES)
        .toString('base64url');
}

function withoutTrailingSlash(address: string): string {
    return address.replace(/\/+$/, '');
}

function challengeOf(codeVerifier: string): string {
    return createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
}

class AppOAuth {
    private readonly deps: AppOAuthDeps;
    private readonly pending = new Map<string, PendingSignIn>();

    constructor(deps: AppOAuthDeps) {
        this.deps = deps;
    }

    // Looks for the server's sign-in page. The address is checked first, with the same rules as connecting.
    async start(botId: string, appName: string, serverUrl: string, redirectUri: string): Promise<AppSignInStart> {
        let address: URL;

        try {
            address = parseAppUrl(serverUrl);
        } catch {
            return { status: 'unsupported' };
        }

        // A token goes only to an https address, so a plain http server cannot finish this sign-in.
        if (address.protocol !== 'https:') {
            return { status: 'unsupported' };
        }

        const endpoints = await discoverOAuth(address.href, this.deps.fetchFunction);

        if (endpoints === undefined) {
            return { status: 'unsupported' };
        }

        const client = await registerClient(endpoints, redirectUri, this.deps.fetchFunction);

        if (client === undefined) {
            return { status: 'failed', problem: FAILED_START };
        }

        const state = randomToken();
        const codeVerifier = randomToken();

        this.dropExpired();
        this.pending.set(state, { botId, appName, serverUrl: address.href, redirectUri, codeVerifier, client, endpoints, expiresAt: this.now() + PENDING_LIFETIME_MS });

        const authorizationUrl = new URL(endpoints.authorizationEndpoint);

        authorizationUrl.searchParams.set('response_type', 'code');
        authorizationUrl.searchParams.set('client_id', client.clientId);
        authorizationUrl.searchParams.set('redirect_uri', redirectUri);
        authorizationUrl.searchParams.set('state', state);
        const codeChallenge = challengeOf(codeVerifier);

        authorizationUrl.searchParams.set('code_challenge', codeChallenge);
        authorizationUrl.searchParams.set('code_challenge_method', 'S256');
        authorizationUrl.searchParams.set('resource', address.href);

        if (endpoints.scopes.length > 0) {
            const scope = endpoints.scopes.join(' ');

            authorizationUrl.searchParams.set('scope', scope);
        }

        return { status: 'redirect', authorizationUrl: authorizationUrl.href };
    }

    // The server sent the owner back. A state that is unknown or used already is refused, so a link made by someone else does nothing.
    async finish(request: AppSignInReturn): Promise<AppSignInFinish> {
        const signIn = request.state === undefined ? undefined : this.pending.get(request.state);

        if (request.state !== undefined) {
            this.pending.delete(request.state);
        }

        if (signIn === undefined || signIn.expiresAt < this.now()) {
            return { outcome: 'failed', botId: undefined, appName: undefined };
        }

        const failed: AppSignInFinish = { outcome: 'failed', botId: signIn.botId, appName: signIn.appName };
        const isIssuerWrong = request.issuer !== undefined && withoutTrailingSlash(request.issuer) !== withoutTrailingSlash(signIn.endpoints.issuer);

        if (request.code === undefined || request.error !== undefined || isIssuerWrong) {
            return failed;
        }

        const form: Record<string, string> = {
            grant_type: 'authorization_code',
            code: request.code,
            redirect_uri: signIn.redirectUri,
            client_id: signIn.client.clientId,
            code_verifier: signIn.codeVerifier,
            resource: signIn.serverUrl,
        };

        if (signIn.client.clientSecret !== undefined) {
            form['client_secret'] = signIn.client.clientSecret;
        }

        const requestTime = this.now();
        const grant = await requestGrant(this.deps.fetchFunction, signIn.endpoints.tokenEndpoint, form, requestTime);

        if (grant === undefined) {
            return failed;
        }

        const secretName = oauthSecretName(signIn.appName);
        const site = new URL(signIn.serverUrl).origin;

        try {
            this.deps.tokens.store(signIn.botId, secretName, site, { grant, clientId: signIn.client.clientId, clientSecret: signIn.client.clientSecret, tokenEndpoint: signIn.endpoints.tokenEndpoint });

            const connection = await this.deps.connectedApps.connect(signIn.botId, { name: signIn.appName, url: signIn.serverUrl, tokenSecret: secretName });

            if (connection.outcome === 'connected') {
                return { ...failed, outcome: 'connected' };
            }
        } catch {
            // The sign-in did not finish, and the token is dropped below like any other that no app uses.
        }

        await this.deps.connectedApps.dropUnusedSecret(signIn.botId, secretName);

        return failed;
    }

    // True while a sign-in waits for the owner to come back. A hub instance stays awake for it, since the state lives in memory.
    hasPending(): boolean {
        const currentTime = this.now();
        const signIns = [...this.pending.values()];

        return signIns.some(signIn => signIn.expiresAt >= currentTime);
    }

    // Sign-ins that nobody finished are dropped, and only the newest ones stay, so the memory held stays small.
    private dropExpired(): void {
        const currentTime = this.now();
        const entries = [...this.pending];

        entries
            .filter(([, signIn]) => signIn.expiresAt < currentTime)
            .forEach(([state]) => {
                this.pending.delete(state);
            });

        const oldestFirst = [...this.pending.keys()];
        const surplusCount = Math.max(0, this.pending.size - MAX_PENDING + 1);
        const surplus = oldestFirst.slice(0, surplusCount);

        surplus.forEach((state) => {
            this.pending.delete(state);
        });
    }

    private now(): number {
        return this.deps.now === undefined ? Date.now() : this.deps.now();
    }
}

export { AppOAuth };
export type { AppOAuthDeps, AppSignInFinish, AppSignInReturn };
