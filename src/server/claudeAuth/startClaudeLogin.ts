import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { buildClaudeCommand } from '../agent/buildClaudeCommand.ts';

type ClaudeLoginFailureReason = 'timeout' | 'cliMissing' | 'exitedWithError' | 'cancelled';

interface ClaudeLoginSuccess {
    ok: true;
}

interface ClaudeLoginFailure {
    ok: false;
    reason: ClaudeLoginFailureReason;
}

type ClaudeLoginResult = ClaudeLoginSuccess | ClaudeLoginFailure;
interface LoginProcessOptions {
    env: Record<string, string>;
}

type SpawnLoginProcess = (command: string, commandArguments: string[], options?: LoginProcessOptions) => ChildProcessWithoutNullStreams;

interface ClaudeLoginOptions {
    claudePath: string;
    agentUser?: string;
    configDir?: string;
    spawnProcess?: SpawnLoginProcess;
    timeoutMs?: number;
}

interface ClaudeLoginSession {
    signInUrl: Promise<string | null>;
    submitCode: (code: string) => void;
    cancel: () => void;
    finished: Promise<ClaudeLoginResult>;
}

function startClaudeLogin(options: ClaudeLoginOptions): ClaudeLoginSession {
    const spawnProcess = options.spawnProcess ?? spawn;
    const invocation = buildClaudeCommand(options.claudePath, ['auth', 'login', '--claudeai'], options.agentUser, options.configDir);
    const escapedPath = invocation.command.replaceAll('\'', '\'"\'"\'');
    const quotedArguments = invocation.args.map(argument => `'${argument.replaceAll('\'', '\'"\'"\'')}'`);
    const argumentsText = invocation.env ? quotedArguments.join(' ') : 'auth login --claudeai';
    const command = `'${escapedPath}' ${argumentsText}`;
    const urlResolvers = Promise.withResolvers<string | null>();
    const finishedResolvers = Promise.withResolvers<ClaudeLoginResult>();
    const signInUrl = urlResolvers.promise;
    const finished = finishedResolvers.promise;
    const resolveUrl = urlResolvers.resolve;
    const resolveFinished = finishedResolvers.resolve;
    let child: ChildProcessWithoutNullStreams | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let isFinished = false;
    let hasUrl = false;
    let output = '';

    function finish(result: ClaudeLoginResult): void {
        if (isFinished) {
            return;
        }

        isFinished = true;
        clearTimeout(timer);
        output = '';
        resolveUrl(null);
        resolveFinished(result);
    }

    function stop(reason: ClaudeLoginFailureReason): void {
        if (isFinished) {
            return;
        }

        finish({ ok: false, reason });
        child?.kill();
    }

    function readUrl(isClosed = false): void {
        const cleanOutput = stripVTControlCharacters(output);
        const match = /https:\/\/[^\s<>"']+/.exec(cleanOutput);

        // A URL can span chunks, so wait for its delimiter or process closure.
        if (match && (isClosed || match.index + match[0].length < cleanOutput.length)) {
            hasUrl = true;
            output = '';
            resolveUrl(match[0]);
        }
    }

    function onOutput(chunk: string): void {
        if (hasUrl || isFinished) {
            return;
        }

        output += chunk;
        readUrl();
        // Bound transient terminal output and never persist or log it.
        output = output.slice(-65536);
    }

    function onError(error: NodeJS.ErrnoException): void {
        const reason = error.code === 'ENOENT' ? 'cliMissing' : 'exitedWithError';

        stop(reason);
    }

    function submitCode(code: string): void {
        if (isFinished) {
            return;
        }

        if (/[\r\n\0]/.test(code)) {
            throw new Error('Sign-in code must be a single line.');
        }

        child?.stdin.write(`${code}\n`);
    }

    try {
        const scriptArguments = ['-q', '-e', '-c', command, '/dev/null'];

        child = invocation.env
            ? spawnProcess('script', scriptArguments, { env: invocation.env })
            : spawnProcess('script', scriptArguments);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', onOutput);
        child.stderr.on('data', onOutput);
        child.on('error', onError);
        child.stdin.on('error', () => {
            stop('exitedWithError');
        });
        child.on('close', (exitCode) => {
            readUrl(true);
            if (exitCode === 0) {
                finish({ ok: true });
            } else {
                // util-linux script returns the shell's 127 when Claude is missing.
                const reason = exitCode === 127 ? 'cliMissing' : 'exitedWithError';

                finish({ ok: false, reason });
            }
        });
        timer = setTimeout(() => {
            stop('timeout');
        }, options.timeoutMs ?? 300000);
    } catch (error) {
        const isMissing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
        const reason = isMissing ? 'cliMissing' : 'exitedWithError';

        finish({ ok: false, reason });
    }

    return {
        signInUrl,
        submitCode,
        cancel: () => {
            stop('cancelled');
        },
        finished,
    };
}

export { startClaudeLogin };
export type { ClaudeLoginFailureReason, ClaudeLoginOptions, ClaudeLoginResult, ClaudeLoginSession, SpawnLoginProcess };
