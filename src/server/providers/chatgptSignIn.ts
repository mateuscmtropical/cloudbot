import { getCodexAuthStatus } from '../codexAuth/getCodexAuthStatus.ts';
import type { CodexAppServerOptions } from '../codexAuth/openCodexAppServer.ts';
import { startCodexLogin } from '../codexAuth/startCodexLogin.ts';
import type { CodexLoginFailureReason } from '../codexAuth/startCodexLogin.ts';
import type { ProviderSignIn } from '../setup/SetupConversation.ts';

const FAILURES: Record<CodexLoginFailureReason, string> = {
    timeout: 'ChatGPT sign-in timed out.',
    cliMissing: 'The Codex CLI is missing.',
    exitedWithError: 'ChatGPT sign-in failed.',
    cancelled: 'ChatGPT sign-in was cancelled.',
    refused: 'OpenAI refused the sign-in.',
};

// The ChatGPT subscription signs in by device code in CloudBot's own Codex home, never in the owner's ~/.codex.
function createChatgptSignIn(options: CodexAppServerOptions): ProviderSignIn {
    return {
        id: 'chatgpt',
        label: 'ChatGPT',
        site: 'OpenAI',
        start: () => {
            const session = startCodexLogin(options);
            const link = session.deviceCode.then(deviceCode => (deviceCode === null ? null : { url: deviceCode.verificationUrl, code: deviceCode.userCode }));
            const finished = session.finished.then(result => (result.ok ? { ok: true as const } : { ok: false as const, reason: FAILURES[result.reason] }));

            return { link, finished, cancel: session.cancel };
        },
        isSignedIn: async () => {
            try {
                const status = await getCodexAuthStatus(options);

                return status.isLoggedIn;
            } catch {
                // An unavailable status does not mean the owner signed out.
                return undefined;
            }
        },
    };
}

export { createChatgptSignIn };
