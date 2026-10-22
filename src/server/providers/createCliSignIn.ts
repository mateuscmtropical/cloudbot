import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type { SignalAction, SpawnFunction } from '../agent/ClaudeCliEngine.ts';
import type { DeviceSignInLink, DeviceSignInResult, DeviceSignInSession, ProviderSignIn } from '../setup/SetupConversation.ts';
import type { ProviderId } from './providerIds.ts';

interface CliSignInOptions {
    id: Exclude<ProviderId, 'claude'>;
    label: string;
    site: string;
    // The command and arguments that start the sign-in, such as the provider wrapper with `login`.
    command: string;
    args: string[];
    environment: Record<string, string>;
    isSignedIn: () => Promise<boolean | undefined>;
    spawnFunction?: SpawnFunction | undefined;
    signalProcess: (child: ChildProcess, action: SignalAction) => void;
    timeoutMs?: number | undefined;
    // True when the provider's page shows a code that the owner pastes back, which goes to the CLI's input.
    needsCode?: boolean | undefined;
    optionLabel?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const LINK_ONLY_WAIT_MS = 2000;
// The CLIs color their text, which would break the link.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;?<>]*[A-Za-z]/g;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/;
// Device codes look like ABCD-1234. Some CLIs put the code in the link too, which is fine.
const CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
// The Gemini CLI says this when Google refuses a pasted code, then waits for another one with a new link.
const CODE_REJECTED_PATTERN = /Failed to authenticate|invalid_grant/i;

function findLink(output: string, needsCode = false): DeviceSignInLink | undefined {
    const text = output.replace(ANSI_PATTERN, '');
    const url = URL_PATTERN.exec(text)?.[0];

    if (url === undefined) {
        return undefined;
    }

    if (needsCode) {
        return { url, needsCode: true };
    }

    const code = CODE_PATTERN.exec(text)?.[0];

    return code === undefined ? { url } : { url, code };
}

// Signs in with the provider's own CLI login, which prints a link and often a device code. The output is read only
// for the link and the code, and it is never logged or stored, since it may carry the code.
function createCliSignIn(options: CliSignInOptions): ProviderSignIn {
    return {
        id: options.id,
        label: options.label,
        site: options.site,
        optionLabel: options.optionLabel,
        start: (): DeviceSignInSession => {
            const spawnFunction = options.spawnFunction ?? spawn;
            const child = spawnFunction(options.command, options.args, {
                env: options.environment,
                stdio: [options.needsCode === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
                shell: false,
                windowsHide: true,
                detached: process.platform !== 'win32',
            });
            let output = '';
            // What the CLI printed after the owner pasted a code.
            let afterCode: string | undefined;
            let isCancelled = false;
            let isCodeRejected = false;
            let resolveLink: (link: DeviceSignInLink | null) => void = () => undefined;
            const link = new Promise<DeviceSignInLink | null>((resolve) => {
                resolveLink = resolve;
            });
            const onOutput = (chunk: Buffer): void => {
                // A long output is cut, since the link comes first.
                output = `${output}${chunk.toString('utf8')}`.slice(0, 8000);

                if (afterCode !== undefined) {
                    afterCode = `${afterCode}${chunk.toString('utf8')}`.slice(-8000);

                    if (CODE_REJECTED_PATTERN.test(afterCode)) {
                        isCodeRejected = true;
                        options.signalProcess(child, 'KILL');
                    }

                    return;
                }

                const found = findLink(output, options.needsCode);

                if (found?.code !== undefined || found?.needsCode === true) {
                    resolveLink(found);

                    return;
                }

                // The code may come a line after the link. A CLI that prints only a link, like Cursor, gets it shown after a moment.
                if (found !== undefined) {
                    setTimeout(() => {
                        resolveLink(findLink(output) ?? found);
                    }, LINK_ONLY_WAIT_MS)
                        .unref();
                }
            };

            child.on('error', () => undefined);
            child.stdout?.on('data', onOutput);
            child.stderr?.on('data', onOutput);

            const timer = setTimeout(() => {
                isCancelled = true;
                options.signalProcess(child, 'KILL');
            }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

            timer.unref();

            const finished = new Promise<DeviceSignInResult>((resolve) => {
                const end = (isOk: boolean): void => {
                    clearTimeout(timer);
                    // A link printed without a code is still a link, such as the Cursor one.
                    resolveLink(findLink(output, options.needsCode) ?? null);
                    output = '';

                    if (isOk) {
                        resolve({ ok: true });

                        return;
                    }

                    if (isCodeRejected) {
                        resolve({ ok: false, reason: `${options.label} did not accept the code. Try again with a new code.` });

                        return;
                    }

                    resolve({ ok: false, reason: isCancelled ? `${options.label} sign-in timed out or was cancelled.` : `${options.label} sign-in failed.` });
                };

                child.once('error', () => {
                    end(false);
                });
                child.once('exit', (code) => {
                    if (code !== 0 || isCancelled) {
                        end(false);

                        return;
                    }

                    // Some CLIs end with 0 even when the owner did not finish, so the sign-in is checked.
                    void options.isSignedIn()
                        .then((isSignedIn) => {
                            end(isSignedIn === true);
                        });
                });
            });

            child.stdin?.on('error', () => undefined);

            return {
                link,
                finished,
                submitCode: (code) => {
                    afterCode = '';
                    child.stdin?.write(`${code}\n`);
                },
                cancel: () => {
                    isCancelled = true;
                    options.signalProcess(child, 'KILL');
                },
            };
        },
        isSignedIn: options.isSignedIn,
    };
}

export { createCliSignIn, findLink };
export type { CliSignInOptions };
