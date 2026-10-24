import { createHash, randomBytes } from 'node:crypto';

import type { AppSignInStart } from '../../shared/connectedApps.ts';
import type { ConnectedApps } from './ConnectedApps.ts';
import { oauthSecretName, requestGrant } from './AppOAuthTokens.ts';
import type { AppOAuthTokens } from './AppOAuthTokens.ts';
import { discoverOAuth, registerClient } from './oauthDiscovery.ts';
import type { OAuthEndpoints, RegisteredClient } from './oauthDiscovery.ts';
import { parseAppUrl } from './appAddress.ts';
import { findGoogleApp } from '../../shared/googleApps.ts';
import type { GoogleApp } from '../../shared/googleApps.ts';
import { googleEndpoints } from './googleClient.ts';
import type { GoogleClientStore } from './googleClient.ts';
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
    // The Google Cloud client of the owner. Without it a Google app answers needs_client.
    googleClient?: Pick<GoogleClientStore, 'read'> | undefined;
    now?: (() => number) | undefined;
}

// What a sign-in needs before it starts.
interface SignInPlan {
    botId: string;
    appName: string;
    serverUrl: string;
    redirectUri: string;
    client: RegisteredClient;
    endpoints: OAuthEndpoints;
    // Google gets fixed endpoints, an offline refresh token, and no resource parameter.
    isGoogle: boolean;
}

// A sign-in the owner has started and not yet finished. It lives in memory, so it ends with a restart.
interface PendingSignIn extends SignInPlan {
    codeVerifier: string;
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

        const googleApp = findGoogleApp(appName, address.href);

        if (googleApp !== undefined) {
            return this.startGoogle(botId, googleApp, redirectUri);
        }

        const endpoints = await discoverOAuth(address.href, this.deps.fetchFunction);

        if (endpoints === undefined) {
            return { status: 'unsupported' };
        }

        const client = await registerClient(endpoints, redirectUri, this.deps.fetchFunction);

        if (client === undefined) {
            return { status: 'failed', problem: FAILED_START };
        }

        return this.beginSignIn({ botId, appName, serverUrl: address.href, redirectUri, client, endpoints, isGoogle: false });
    }

    // Google has fixed endpoints and no registration, so the client the owner saved in the vault is used.
    private startGoogle(botId: string, googleApp: GoogleApp, redirectUri: string): AppSignInStart {
        const savedClient = this.deps.googleClient?.read(botId);

        if (savedClient === undefined) {
            return { status: 'needs_client' };
        }

        const endpoints = googleEndpoints(googleApp);

        return this.beginSignIn({ botId, appName: googleApp.serverName, serverUrl: googleApp.url, redirectUri, client: savedClient, endpoints, isGoogle: true });
    }

    private beginSignIn(plan: SignInPlan): AppSignInStart {
        const state = randomToken();
        const codeVerifier = randomToken();

        this.dropExpired();
        this.pending.set(state, { ...plan, codeVerifier, expiresAt: this.now() + PENDING_LIFETIME_MS });

        const authorizationUrl = new URL(plan.endpoints.authorizationEndpoint);

        authorizationUrl.searchParams.set('response_type', 'code');
        authorizationUrl.searchParams.set('client_id', plan.client.clientId);
        authorizationUrl.searchParams.set('redirect_uri', plan.redirectUri);
        authorizationUrl.searchParams.set('state', state);
        const codeChallenge = challengeOf(codeVerifier);

        authorizationUrl.searchParams.set('code_challenge', codeChallenge);
        authorizationUrl.searchParams.set('code_challenge_method', 'S256');

        // Google does not document the resource parameter, and it hands out a refresh token only on request.
        if (plan.isGoogle) {
            authorizationUrl.searchParams.set('access_type', 'offline');
            authorizationUrl.searchParams.set('prompt', 'consent');
        } else {
            authorizationUrl.searchParams.set('resource', plan.serverUrl);
        }

        if (plan.endpoints.scopes.length > 0) {
            const scope = plan.endpoints.scopes.join(' ');

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
        };

        if (!signIn.isGoogle) {
            form['resource'] = signIn.serverUrl;
        }

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
