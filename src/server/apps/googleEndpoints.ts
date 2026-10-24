import type { OAuthEndpoints } from './oauthDiscovery.ts';

// Google signs in at fixed addresses, with the OAuth client of the server (see googleClientEnv.ts).

const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// On a hub, Google sends the owner back to the apex of the hub, since Google takes one redirect address.
// The apex reads the person from the start of the state and sends the browser on to that person's address.
interface GoogleHubRoute {
    personName: string;
    // The origin of the hub apex, such as https://example.com.
    apexOrigin: string;
}

// The endpoints are fixed. There is no registration endpoint, so the field stays empty and is never used.
function googleEndpoints(scopes: string[]): OAuthEndpoints {
    return {
        issuer: GOOGLE_ISSUER,
        authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
        tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
        registrationEndpoint: '',
        scopes,
    };
}

// The public address of a person is https://<name>.<apex>, so the apex is that host without the first label.
// Undefined when the address does not start with the person name, and the sign-in then uses its own address.
function readGoogleHubRoute(publicUrl: string | undefined, personName: string): GoogleHubRoute | undefined {
    try {
        const address = new URL(publicUrl ?? '');
        const prefix = `${personName}.`;

        if (!address.hostname.startsWith(prefix)) {
            return undefined;
        }

        const apexHost = address.host.slice(prefix.length);

        return { personName, apexOrigin: `${address.protocol}//${apexHost}` };
    } catch {
        return undefined;
    }
}

export { googleEndpoints, readGoogleHubRoute };
export type { GoogleHubRoute };
