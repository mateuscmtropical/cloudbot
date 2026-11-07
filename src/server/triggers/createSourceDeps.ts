import type { ConnectedApps } from '../apps/ConnectedApps.ts';
import { readGithubToken } from '../github/githubRouting.ts';
import type { BotSecrets } from '../secrets/BotSecrets.ts';
import type { SourceDeps } from './triggerSources.ts';

const REQUEST_TIMEOUT_MS = 15 * 1000;
const HTTPS_PREFIX = 'https://';

// The real calls. The addresses are fixed by the sources, never typed by the owner or taken from app content,
// so a token goes only to api.github.com or Google's API. Redirects are not followed.
function createSourceDeps(secrets: Pick<BotSecrets, 'read'>, connectedApps: Pick<ConnectedApps, 'googleAccessToken'>): SourceDeps {
    return {
        getJson: async (url, token) => {
            if (!url.startsWith(HTTPS_PREFIX)) {
                throw new Error('Only https addresses are read.');
            }

            const headers: Record<string, string> = { 'accept': 'application/json', 'user-agent': 'cloudbot' };

            if (token !== undefined) {
                headers['authorization'] = `Bearer ${token}`;
            }

            const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

            if (!response.ok) {
                await response.body?.cancel();

                throw new Error(`The app answered with status ${String(response.status)}.`);
            }

            return await response.json();
        },
        githubToken: (botId) => {
            try {
                return readGithubToken(secrets, botId);
            } catch {
                return undefined;
            }
        },
        googleToken: serverName => connectedApps.googleAccessToken(serverName),
    };
}

export { createSourceDeps };
