import { openCodexAppServer } from './openCodexAppServer.ts';
import type { CodexAppServerOptions } from './openCodexAppServer.ts';

interface CodexAuthStatus {
    isLoggedIn: boolean;
    // The account type from Codex, such as chatgpt or apiKey. The email and plan are never read.
    method?: string;
}

const STATUS_FAILED = 'Could not check Codex sign-in status. Verify that Codex is installed and try again.';

function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Reads the sign-in state of the bot's CODEX_HOME with `account/read` (codex-cli 0.163.0), without a token refresh.
async function getCodexAuthStatus(options: CodexAppServerOptions): Promise<CodexAuthStatus> {
    let answer;

    try {
        const server = await openCodexAppServer(options);

        try {
            answer = await server.call('account/read', { refreshToken: false });
        } finally {
            await server.close();
        }
    } catch {
        throw new Error(STATUS_FAILED);
    }

    const result = readRecord(answer.result);

    if (answer.error !== undefined || !('account' in result)) {
        throw new Error(STATUS_FAILED);
    }

    if (result.account === null) {
        return { isLoggedIn: false };
    }

    const account = readRecord(result.account);

    if (typeof account.type !== 'string') {
        throw new Error(STATUS_FAILED);
    }

    return { isLoggedIn: true, method: account.type };
}

export { getCodexAuthStatus };
export type { CodexAuthStatus };
