import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

import type { CodexAgentLaunch } from '../agent/codexAgentLaunch.ts';
import type { ReviewModel } from './createToolCallReviewer.ts';

interface CodexReviewModelOptions {
    launch: CodexAgentLaunch;
    timeoutMs?: number;
}

interface CodexReviewLine {
    id?: number;
    method?: string;
    error?: { message?: string };
    result?: { thread?: { id?: string } };
    params?: { item?: { type?: string; text?: string } };
}

// A review that hangs would hold the bot, so the call gives up and the owner decides.
const DEFAULT_REVIEW_TIMEOUT_MS = 60_000;
const REVIEW_INSTRUCTIONS = 'You are a careful reviewer of tool calls. You run no commands. You answer with one JSON object and nothing else.';
const INITIALIZE_ID = 1;
const THREAD_ID = 2;
const TURN_ID = 3;

function readLine(line: string): CodexReviewLine | undefined {
    try {
        return JSON.parse(line) as CodexReviewLine;
    } catch {
        return undefined;
    }
}

// Runs one turn of `codex app-server` with the ChatGPT sign-in for each review when Claude is not signed in.
// The thread is read-only and never asks, so the model can only answer in text. A subscription is not billed per call.
function createCodexReviewModel(options: CodexReviewModelOptions): ReviewModel {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;

    return (prompt, signal) => new Promise((resolve, reject) => {
        const child = options.launch.spawnFunction('codex', ['app-server'], {
            cwd: tmpdir(),
            env: {},
            stdio: ['pipe', 'pipe', 'ignore'],
            shell: false,
            windowsHide: true,
            detached: true,
        });
        const state = { answer: undefined as string | undefined };
        const write = (message: unknown): void => {
            child.stdin?.write(`${JSON.stringify(message)}\n`);
        };
        const stop = (): void => {
            options.launch.signalProcess(child, 'KILL');
        };
        const timer = setTimeout(stop, timeoutMs);

        signal?.addEventListener('abort', stop, { once: true });
        child.on('error', () => undefined);
        child.stdin?.on('error', () => undefined);

        if (child.stdout === null) {
            clearTimeout(timer);
            stop();
            reject(new Error('The review model could not start.'));

            return;
        }

        const lines = createInterface({ input: child.stdout });

        lines.on('line', (line) => {
            const message = readLine(line);

            if (message === undefined) {
                return;
            }

            if (message.error !== undefined) {
                stop();

                return;
            }

            if (message.id === INITIALIZE_ID) {
                write({ jsonrpc: '2.0', method: 'initialized' });
                write({ jsonrpc: '2.0', id: THREAD_ID, method: 'thread/start', params: { cwd: tmpdir(), approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: REVIEW_INSTRUCTIONS, ephemeral: true } });
            }

            const threadId = message.result?.thread?.id;

            if (message.id === THREAD_ID && threadId !== undefined) {
                write({ jsonrpc: '2.0', id: TURN_ID, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], effort: 'low' } });
            }

            const item = message.params?.item;

            if (message.method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string') {
                state.answer = item.text;
            }

            if (message.method === 'turn/completed') {
                stop();
            }
        });
        lines.on('close', () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', stop);

            if (state.answer === undefined || state.answer.trim() === '') {
                reject(new Error('The review model did not answer.'));

                return;
            }

            resolve(state.answer);
        });

        write({ jsonrpc: '2.0', id: INITIALIZE_ID, method: 'initialize', params: { clientInfo: { name: 'cloudbot-review', title: null, version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } } });
    });
}

export { createCodexReviewModel };
export type { CodexReviewModelOptions };
