import { openCodexAppServer } from './openCodexAppServer.ts';
import type { CodexAppServerOptions } from './openCodexAppServer.ts';

// Reads the plan limits of the bot's CODEX_HOME with `account/rateLimits/read` (codex-cli 0.166.0), the call the Codex
// app shows its own usage with. The answer is read by parseCodexRateLimits. It fails when Codex cannot answer.
async function getCodexUsage(options: CodexAppServerOptions): Promise<unknown> {
    const server = await openCodexAppServer(options);

    try {
        const answer = await server.call('account/rateLimits/read', { excludeResetCreditDetails: true });

        if (answer.error !== undefined) {
            throw new Error('Could not read the Codex usage.');
        }

        return answer.result;
    } finally {
        await server.close();
    }
}

export { getCodexUsage };
