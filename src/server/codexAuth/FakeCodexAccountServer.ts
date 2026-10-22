import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { SpawnFunction } from '../agent/ClaudeCliEngine.ts';

interface FakeAccountMessage {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
}

// Answers one account request. Undefined sends no answer, so the caller has to time out.
type FakeAccountAnswer = (message: FakeAccountMessage, server: FakeCodexAccountServer) => unknown;

type FakeAccountAnswers = [method: string, answer: FakeAccountAnswer][];

// A stand-in for `codex app-server` that answers the initialize handshake and the account calls a test scripts.
class FakeCodexAccountServer extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly sent: FakeAccountMessage[] = [];
    pid = 4343;
    private readonly answers: FakeAccountAnswers;

    constructor(answers: FakeAccountAnswers) {
        super();
        this.answers = answers;
        let buffer = '';

        this.stdin.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            const parts = buffer.split('\n');

            buffer = parts.pop() ?? '';
            parts.filter(part => part !== '')
                .forEach((part) => {
                    this.receive(JSON.parse(part) as FakeAccountMessage);
                });
        });
        this.stdin.on('finish', () => {
            this.exit();
        });
    }

    say(message: unknown): void {
        if (!this.stdout.writableEnded) {
            this.stdout.write(`${JSON.stringify(message)}\n`);
        }
    }

    exit(): void {
        if (!this.stdout.writableEnded) {
            this.stdout.end();
            this.emit('exit', 0);
        }
    }

    methods(): string[] {
        return this.sent.flatMap(message => message.method === undefined ? [] : [message.method]);
    }

    private receive(message: FakeAccountMessage): void {
        this.sent.push(message);

        if (message.method === 'initialize') {
            this.say({ id: message.id, result: { userAgent: 'fake', codexHome: '/x', platformFamily: 'unix', platformOs: 'linux' } });

            return;
        }

        const answer = this.answers.find(([method]) => method === message.method)?.[1];
        const result = answer?.(message, this);

        if (result !== undefined) {
            this.say({ id: message.id, ...result });
        }
    }
}

interface FakeAccountSpawn {
    spawnFunction: SpawnFunction;
    servers: FakeCodexAccountServer[];
    spawnCalls: { command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[];
}

function fakeAccountSpawn(answers: FakeAccountAnswers): FakeAccountSpawn {
    const servers: FakeCodexAccountServer[] = [];
    const spawnCalls: FakeAccountSpawn['spawnCalls'] = [];
    const spawnFunction: SpawnFunction = (command, args, options) => {
        const server = new FakeCodexAccountServer(answers);

        servers.push(server);
        spawnCalls.push({ command, args, env: options.env });

        return server as unknown as ChildProcess;
    };

    return { spawnFunction, servers, spawnCalls };
}

// A spawn that fails like a missing binary.
function missingSpawn(): SpawnFunction {
    return () => {
        const child = new FakeCodexAccountServer([]);

        // A binary that never started reads nothing.
        child.stdin.removeAllListeners('data');
        queueMicrotask(() => {
            const error = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });

            child.emit('error', error);
        });

        return child as unknown as ChildProcess;
    };
}

export { FakeCodexAccountServer, fakeAccountSpawn, missingSpawn };
export type { FakeAccountAnswer, FakeAccountAnswers, FakeAccountMessage, FakeAccountSpawn };
