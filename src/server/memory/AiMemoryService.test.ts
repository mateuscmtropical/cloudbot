import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiMemoryService, buildAiMemoryArguments, createAiMemoryService, renderAiMemoryConfig } from './AiMemoryService.ts';

// Long enough for the restart delay of the supervisor and two probe rounds.
const SETTLE_MS = 3_000;

interface FakeChild extends EventEmitter {
    stderr: PassThrough;
    killSignals: string[];
    kill: (signal: string) => boolean;
}

function createFakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;

    child.stderr = new PassThrough();
    child.killSignals = [];
    child.kill = (signal: string): boolean => {
        child.killSignals.push(signal);

        return true;
    };

    return child;
}

describe('buildAiMemoryArguments', () => {
    it('puts the global flags before serve and binds the loopback address only', () => {
        expect(buildAiMemoryArguments('/var/lib/cloudbot/ai-memory', '/var/lib/cloudbot/ai-memory/config.toml', 9226))
            .toEqual(['--data-dir', '/var/lib/cloudbot/ai-memory', '--config', '/var/lib/cloudbot/ai-memory/config.toml', 'serve', '--transport', 'http', '--bind', '127.0.0.1:9226']);
    });
});

describe('renderAiMemoryConfig', () => {
    it('turns local embeddings off, so the server never downloads a model', () => {
        expect(renderAiMemoryConfig())
            .toContain('embedding_provider = "none"');
    });
});

describe('AiMemoryService', () => {
    let folder: string;
    let children: FakeChild[];
    let spawnCalls: { command: string; args: string[] }[];
    let logs: string[];
    let answer: { isUp: boolean };

    function createService(): AiMemoryService {
        return new AiMemoryService({
            binaryPath: '/usr/local/bin/ai-memory',
            folder,
            port: 9226,
            spawnFunction: (command, args) => {
                const child = createFakeChild();

                spawnCalls.push({ command, args });
                children.push(child);

                return child as unknown as ChildProcess;
            },
            probe: () => Promise.resolve(answer.isUp),
            log: (message) => {
                logs.push(message);
            },
        });
    }

    beforeEach(async () => {
        vi.useFakeTimers();
        folder = join(await mkdtemp(join(tmpdir(), 'cloudbot-ai-memory-')), 'ai-memory');
        children = [];
        spawnCalls = [];
        logs = [];
        answer = { isUp: false };
    });

    afterEach(async () => {
        vi.useRealTimers();
        await rm(join(folder, '..'), { recursive: true, force: true });
    });

    it('writes the config first, then starts the binary with the store folder and the config', async () => {
        const service = createService();

        service.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(readFileSync(join(folder, 'config.toml'), 'utf8'))
            .toBe(renderAiMemoryConfig());
        expect(spawnCalls)
            .toEqual([{
                command: '/usr/local/bin/ai-memory',
                args: ['--data-dir', folder, '--config', join(folder, 'config.toml'), 'serve', '--transport', 'http', '--bind', '127.0.0.1:9226'],
            }]);

        service.stop();
    });

    it('offers the server to turns only after it answers the probe', async () => {
        const service = createService();

        service.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(service.serverConfig())
            .toBeUndefined();

        answer.isUp = true;
        await vi.advanceTimersByTimeAsync(SETTLE_MS);

        expect(service.serverConfig())
            .toEqual({ type: 'http', url: 'http://127.0.0.1:9226/mcp' });

        service.stop();
    });

    it('starts the server again after it exits, and offers it again once it answers', async () => {
        const service = createService();

        answer.isUp = true;
        service.start();
        await vi.advanceTimersByTimeAsync(SETTLE_MS);

        children[0]?.emit('exit', 1);
        children[0]?.emit('close', 1);

        expect(service.serverConfig())
            .toBeUndefined();

        await vi.advanceTimersByTimeAsync(SETTLE_MS);

        expect(spawnCalls)
            .toHaveLength(2);
        expect(service.serverConfig())
            .toEqual({ type: 'http', url: 'http://127.0.0.1:9226/mcp' });

        service.stop();
    });

    it('stops the server and does not start it again', async () => {
        const service = createService();

        answer.isUp = true;
        service.start();
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        service.stop();
        await vi.advanceTimersByTimeAsync(SETTLE_MS);

        expect(children[0]?.killSignals)
            .toEqual(['SIGTERM']);
        expect(spawnCalls)
            .toHaveLength(1);
        expect(service.serverConfig())
            .toBeUndefined();
    });

    it('names the process ai-memory in its log lines', async () => {
        const service = createService();

        service.start();
        await vi.advanceTimersByTimeAsync(0);
        children[0]?.emit('close', 1);

        expect(logs)
            .toContain('The ai-memory exited with code 1.');

        service.stop();
    });
});

describe('createAiMemoryService', () => {
    it('is off when the switch is off, even when the binary is there', () => {
        expect(createAiMemoryService({ isEnabled: false, dataDir: '/var/lib/cloudbot', binaryExists: () => true }))
            .toBeUndefined();
    });

    it('is off with a log line when the image has no binary', () => {
        const warnings = vi.spyOn(console, 'warn')
            .mockImplementation(() => undefined);

        expect(createAiMemoryService({ isEnabled: true, dataDir: '/var/lib/cloudbot', binaryExists: () => false }))
            .toBeUndefined();
        expect(warnings)
            .toHaveBeenCalledWith('ai-memory is off, because /usr/local/bin/ai-memory is not installed.');

        warnings.mockRestore();
    });

    it('checks the binary the image installs, and is on when it is there', () => {
        const checkedPaths: string[] = [];
        const service = createAiMemoryService({
            isEnabled: true,
            dataDir: '/var/lib/cloudbot',
            binaryExists: (path) => {
                checkedPaths.push(path);

                return true;
            },
        });

        expect(service)
            .toBeInstanceOf(AiMemoryService);
        expect(checkedPaths)
            .toEqual(['/usr/local/bin/ai-memory']);
    });
});
