import { getCodexAuthStatus } from './getCodexAuthStatus.ts';
import { openCodexAppServer } from './openCodexAppServer.ts';
import type { CodexAppServerOptions } from './openCodexAppServer.ts';

const SIGN_OUT_FAILED = 'Could not sign out of Codex. Try again.';

// Runs Codex's own `account/logout` in the bot's CODEX_HOME, then checks that the bot is signed out.
async function signOutCodex(options: CodexAppServerOptions): Promise<void> {
    try {
        const server = await openCodexAppServer(options);
        let answer;

        try {
            answer = await server.call('account/logout', undefined);
        } finally {
            await server.close();
        }

        if (answer.error !== undefined) {
            throw new Error(SIGN_OUT_FAILED);
        }

        const status = await getCodexAuthStatus(options);

        if (status.isLoggedIn) {
            throw new Error(SIGN_OUT_FAILED);
        }
    } catch {
        throw new Error(SIGN_OUT_FAILED);
    }
}

export { signOutCodex };
