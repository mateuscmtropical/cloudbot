import { CodexAppServerError, openCodexAppServer } from './openCodexAppServer.ts';
import type { CodexAppServer, CodexAppServerOptions } from './openCodexAppServer.ts';

type CodexLoginFailureReason = 'timeout' | 'cliMissing' | 'exitedWithError' | 'cancelled' | 'refused';

interface CodexLoginSuccess {
    ok: true;
}

interface CodexLoginFailure {
    ok: false;
    reason: CodexLoginFailureReason;
}

type CodexLoginResult = CodexLoginSuccess | CodexLoginFailure;

// What the owner needs to sign in on OpenAI's page. The code is shown to the owner only, never logged or stored.
interface CodexDeviceCode {
    verificationUrl: string;
    userCode: string;
}

interface CodexLoginOptions extends CodexAppServerOptions {
    timeoutMs?: number | undefined;
}

interface CodexLoginSession {
    // Null when the sign-in ends before Codex gives a code.
    deviceCode: Promise<CodexDeviceCode | null>;
    cancel: () => void;
    finished: Promise<CodexLoginResult>;
}

// How long CloudBot waits for the owner. OpenAI does not state the device code lifetime in the Codex protocol, so this
// is CloudBot's own limit, not a vendor value.
const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const LOGIN_TYPE = 'chatgptDeviceCode';

function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isHttpsUrl(text: string): boolean {
    try {
        return new URL(text).protocol === 'https:';
    } catch {
        return false;
    }
}

// Starts a ChatGPT sign-in by device code in the bot's own app server (`account/login/start`, codex-cli 0.163.0).
// Codex keeps the tokens in the bot's CODEX_HOME. CloudBot never reads them and never uses the token or key sign-in.
function startCodexLogin(options: CodexLoginOptions): CodexLoginSession {
    const codeResolvers = Promise.withResolvers<CodexDeviceCode | null>();
    const finishedResolvers = Promise.withResolvers<CodexLoginResult>();
    let server: CodexAppServer | undefined;
    let loginId: string | undefined;
    const state = { isFinished: false };
    // A function, so a check after an await is not narrowed away by the type checker.
    const isOver = (): boolean => state.isFinished;

    const timer = setTimeout(() => {
        finish({ ok: false, reason: 'timeout' });
    }, options.timeoutMs ?? DEVICE_CODE_TIMEOUT_MS);

    function finish(result: CodexLoginResult): void {
        if (state.isFinished) {
            return;
        }

        state.isFinished = true;
        clearTimeout(timer);
        codeResolvers.resolve(null);
        finishedResolvers.resolve(result);

        const openServer = server;

        // A sign-in that did not finish is cancelled first, so Codex stops polling OpenAI.
        if (openServer !== undefined) {
            const cancelled = !result.ok && loginId !== undefined
                ? openServer.call('account/login/cancel', { loginId })
                : Promise.resolve(undefined);

            void cancelled.then(() => openServer.close());
        }
    }

    function onNotification(method: string, params: unknown): void {
        if (method !== 'account/login/completed' || loginId === undefined) {
            return;
        }

        const completed = readRecord(params);

        // Only this sign-in runs in this app server, so a missing id is still ours.
        if (completed.loginId !== loginId && completed.loginId !== null) {
            return;
        }

        finish(completed.success === true ? { ok: true } : { ok: false, reason: 'refused' });
    }

    async function run(): Promise<void> {
        try {
            server = await openCodexAppServer(options);
        } catch (error) {
            finish({ ok: false, reason: error instanceof CodexAppServerError ? error.reason : 'exitedWithError' });

            return;
        }

        if (isOver()) {
            await server.close();

            return;
        }

        server.onNotification(onNotification);
        void server.exited.then(() => {
            finish({ ok: false, reason: 'exitedWithError' });
        });

        const answer = await server.call('account/login/start', { type: LOGIN_TYPE });
        const started = readRecord(answer.result);
        const isDeviceCode = started.type === LOGIN_TYPE
            && typeof started.loginId === 'string'
            && typeof started.userCode === 'string'
            && typeof started.verificationUrl === 'string';

        if (isDeviceCode) {
            loginId = started.loginId as string;
        }

        // A cancel or timeout during the call has already closed the app server, which ends the sign-in.
        if (isOver()) {
            return;
        }

        // Only an https page is shown to the owner.
        if (!isDeviceCode || !isHttpsUrl(started.verificationUrl as string)) {
            finish({ ok: false, reason: 'exitedWithError' });

            return;
        }

        codeResolvers.resolve({ verificationUrl: started.verificationUrl as string, userCode: started.userCode as string });
    }

    timer.unref();
    void run()
        .catch(() => {
            finish({ ok: false, reason: 'exitedWithError' });
        });

    return {
        deviceCode: codeResolvers.promise,
        cancel: () => {
            finish({ ok: false, reason: 'cancelled' });
        },
        finished: finishedResolvers.promise,
    };
}

export { DEVICE_CODE_TIMEOUT_MS, startCodexLogin };
export type { CodexDeviceCode, CodexLoginFailureReason, CodexLoginOptions, CodexLoginResult, CodexLoginSession };
