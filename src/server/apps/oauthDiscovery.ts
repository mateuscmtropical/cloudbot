import { Readable } from 'node:stream';

import { readCapped } from './readCapped.ts';
import type { FetchFunction } from './probeAppServer.ts';

// Finds the sign-in page of a remote MCP server, as the MCP authorization rules describe it. The server names its
// authorization server in /.well-known/oauth-protected-resource, and that one names the endpoints.
// Every request goes through the fetch function it is given, which checks the address first.

interface OAuthEndpoints {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint: string;
    // The scopes the server lists, so the sign-in asks for what the server offers.
    scopes: string[];
}

interface RegisteredClient {
    clientId: string;
    clientSecret: string | undefined;
}

const DISCOVERY_TIMEOUT_MS = 15 * 1000;
const MAX_METADATA_BYTES = 256 * 1024;
const WELL_KNOWN = '/.well-known';
const CLIENT_NAME = 'CloudBot';

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readText(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];

    return typeof value === 'string' && value !== '' ? value : undefined;
}

function readTexts(record: Record<string, unknown>, key: string): string[] {
    const value = record[key];

    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function readJsonBody(response: Response): Promise<Record<string, unknown> | undefined> {
    if (response.body === null) {
        return undefined;
    }

    const bodyStream = Readable.fromWeb(response.body);
    const bytes = await readCapped(bodyStream, MAX_METADATA_BYTES);
    const text = bytes.toString('utf8');

    try {
        const parsed: unknown = JSON.parse(text);

        return readRecord(parsed);
    } catch {
        return undefined;
    }
}

// Any failure is "not found", since a server without a sign-in page is a normal answer.
async function getJson(fetchFunction: FetchFunction, url: string): Promise<Record<string, unknown> | undefined> {
    try {
        const response = await fetchFunction(url, {
            method: 'GET',
            headers: { accept: 'application/json' },
            redirect: 'manual',
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });

        if (!response.ok) {
            await response.body?.cancel();

            return undefined;
        }

        return await readJsonBody(response);
    } catch {
        return undefined;
    }
}

async function firstJson(fetchFunction: FetchFunction, urls: string[]): Promise<Record<string, unknown> | undefined> {
    const noResult = Promise.resolve<Record<string, unknown> | undefined>(undefined);

    return urls.reduce<Promise<Record<string, unknown> | undefined>>(async (found, url) => {
        const previous = await found;

        return previous ?? getJson(fetchFunction, url);
    }, noResult);
}

// The path of the server goes after the well-known name, so one host can hold several servers.
function wellKnownUrls(address: URL, name: string): string[] {
    const path = address.pathname.replace(/\/+$/, '');
    const rootUrl = `${address.origin}${WELL_KNOWN}/${name}`;

    return path === '' ? [rootUrl] : [`${rootUrl}${path}`, rootUrl];
}

// An endpoint must be https, unless the server itself is plain http, which only a private host the owner allowed can be.
function readEndpoint(value: string | undefined, server: URL): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    try {
        const endpoint = new URL(value);
        const isSecure = endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && server.protocol === 'http:');

        return isSecure && endpoint.username === '' && endpoint.password === '' ? endpoint.href : undefined;
    } catch {
        return undefined;
    }
}

function withoutTrailingSlash(address: string): string {
    return address.replace(/\/+$/, '');
}

function isSameOrigin(address: string, origin: string): boolean {
    try {
        return new URL(address).origin === origin;
    } catch {
        return false;
    }
}

function authorizationServerOf(resource: Record<string, unknown> | undefined, server: URL): URL {
    const [firstServer] = resource === undefined ? [] : readTexts(resource, 'authorization_servers');

    try {
        return new URL(firstServer ?? server.origin);
    } catch {
        return new URL(server.origin);
    }
}

// The sign-in endpoints of a server, or undefined when it offers none that an app can use.
// An app needs a way to register itself and the S256 code challenge, since no key is shared in advance.
async function discoverOAuth(serverUrl: string, fetchFunction: FetchFunction): Promise<OAuthEndpoints | undefined> {
    const server = new URL(serverUrl);
    const resourceUrls = wellKnownUrls(server, 'oauth-protected-resource');
    const resource = await firstJson(fetchFunction, resourceUrls);

    if (resource === undefined) {
        return undefined;
    }

    // The server must speak for itself, and the authorization server for itself, or the sign-in could be pointed at a stranger.
    const resourceText = readText(resource, 'resource');

    if (resourceText !== undefined && !isSameOrigin(resourceText, server.origin)) {
        return undefined;
    }

    const issuerUrl = authorizationServerOf(resource, server);
    const metadataUrls = [...wellKnownUrls(issuerUrl, 'oauth-authorization-server'), `${issuerUrl.href.replace(/\/+$/, '')}${WELL_KNOWN}/openid-configuration`];
    const metadata = await firstJson(fetchFunction, metadataUrls);

    if (metadata === undefined) {
        return undefined;
    }

    const authorizationText = readText(metadata, 'authorization_endpoint');
    const tokenText = readText(metadata, 'token_endpoint');
    const registrationText = readText(metadata, 'registration_endpoint');
    const authorizationEndpoint = readEndpoint(authorizationText, server);
    const tokenEndpoint = readEndpoint(tokenText, server);
    const registrationEndpoint = readEndpoint(registrationText, server);
    const methods = readTexts(metadata, 'code_challenge_methods_supported');
    const isChallengeSupported = methods.length === 0 || methods.includes('S256');

    if (authorizationEndpoint === undefined || tokenEndpoint === undefined || registrationEndpoint === undefined || !isChallengeSupported) {
        return undefined;
    }

    const issuer = readText(metadata, 'issuer') ?? issuerUrl.origin;

    if (withoutTrailingSlash(issuer) !== withoutTrailingSlash(issuerUrl.href)) {
        return undefined;
    }

    return {
        issuer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint,
        scopes: readTexts(resource, 'scopes_supported'),
    };
}

// Registers CloudBot as a public client that will come back to one address. The server hands out a client id for it.
async function registerClient(endpoints: OAuthEndpoints, redirectUri: string, fetchFunction: FetchFunction): Promise<RegisteredClient | undefined> {
    try {
        const response = await fetchFunction(endpoints.registrationEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'accept': 'application/json' },
            body: JSON.stringify({
                client_name: CLIENT_NAME,
                redirect_uris: [redirectUri],
                grant_types: ['authorization_code', 'refresh_token'],
                response_types: ['code'],
                token_endpoint_auth_method: 'none',
            }),
            redirect: 'manual',
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });

        if (!response.ok) {
            await response.body?.cancel();

            return undefined;
        }

        const registered = await readJsonBody(response);
        const clientId = registered === undefined ? undefined : readText(registered, 'client_id');

        if (registered === undefined || clientId === undefined) {
            return undefined;
        }

        return { clientId, clientSecret: readText(registered, 'client_secret') };
    } catch {
        return undefined;
    }
}

export { discoverOAuth, readJsonBody, readRecord, readText, registerClient };
export type { OAuthEndpoints, RegisteredClient };
