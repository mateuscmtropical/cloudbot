import { EventEmitter } from 'node:events';

import { afterEach, expect, it, vi } from 'vitest';

import type { ClaudeLoginSession } from './claudeAuth/startClaudeLogin.ts';

interface TestServer extends EventEmitter {
    close: () => void;
    closeAllConnections: () => void;
}

interface TestBot {
    id: string;
}

interface CancelledLogin {
    ok: false;
    reason: 'cancelled';
}

interface ListeningAddress {
    port: number;
}

const runtime = vi.hoisted(() => ({
    listen: undefined as ((address: ListeningAddress) => void) | undefined,
    session: undefined as ClaudeLoginSession | undefined,
    server: undefined as TestServer | undefined,
    startLogin: vi.fn(),
    post: vi.fn(),
}));

vi.mock('@hono/node-server', () => ({
    serve: (_options: unknown, callback: (address: ListeningAddress) => void) => {
        runtime.listen = callback;

        return runtime.server;
    },
}));
vi.mock('./agent/buildClaudeCommand.ts', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const actual: Record<string, unknown> = await vi.importActual('./agent/buildClaudeCommand.ts');

    return { ...actual, validateAgentIsolation: vi.fn(), localClaudeConfigDir: () => path.join(os.tmpdir(), 'cloudbot-main-test-claude-config') };
});
vi.mock('./agent/SdkAgentRunner.ts', () => ({ SdkAgentRunner: class {
    readonly testStub = true;
} }));
vi.mock('./access/SetupAccess.ts', () => ({
    SetupAccess: class {
        hasSession(): Promise<boolean> {
            return Promise.resolve(true);
        }
    },
}));
vi.mock('./store/openDatabase.ts', () => ({ openDatabase: () => Promise.resolve({ db: {} }) }));
vi.mock('./store/ensureDefaultBot.ts', () => ({ ensureDefaultBot: vi.fn() }));
vi.mock('./store/ConnectedAppStore.ts', () => ({ ConnectedAppStore: class {
    list(): Promise<unknown[]> {
        return Promise.resolve([]);
    }
} }));
vi.mock('./store/SettingsStore.ts', () => ({
    SettingsStore: class {
        get(): Promise<string> {
            return Promise.resolve('{"step":"login","mode":"subscription"}');
        }

        set(): Promise<void> {
            return Promise.resolve();
        }
    },
}));
vi.mock('./store/BotStore.ts', () => ({
    BotStore: class {
        list(): Promise<TestBot[]> {
            return Promise.resolve([{ id: 'setup-bot' }]);
        }
    },
}));
vi.mock('./store/MessageStore.ts', () => ({ MessageStore: class {
    readonly testStub = true;
} }));
vi.mock('./vault/Vault.ts', () => ({ Vault: class {
    readonly testStub = true;
} }));
vi.mock('./chat/ChatService.ts', () => ({
    ChatService: class {
        setSetup(): void {}

        async resumeQueue(): Promise<void> {}

        cleanUploads(): Promise<string[]> {
            return Promise.resolve([]);
        }

        postSetupMessage = runtime.post;
    },
}));
vi.mock('./claudeAuth/getClaudeAuthStatus.ts', () => ({
    getClaudeAuthStatus: () => Promise.resolve({ isLoggedIn: false }),
}));
vi.mock('./claudeAuth/startClaudeLogin.ts', () => ({
    startClaudeLogin: () => {
        runtime.startLogin();

        return runtime.session;
    },
}));
vi.mock('./createApp.ts', () => ({ createApp: () => ({ fetch: vi.fn() }) }));

afterEach(() => {
    vi.restoreAllMocks();
});

it('listens before starting a stalled login and cancels it on shutdown', async () => {
    const signInUrl = Promise.withResolvers<string | null>();
    const finished = Promise.withResolvers<CancelledLogin>();
    const cancel = vi.fn(() => {
        finished.resolve({ ok: false, reason: 'cancelled' });
    });
    const oldInterrupt = process.listeners('SIGINT');
    const oldTerminate = process.listeners('SIGTERM');
    const server = Object.assign(new EventEmitter(), { close: vi.fn(), closeAllConnections: vi.fn() });

    runtime.server = server;
    runtime.session = { signInUrl: signInUrl.promise, finished: finished.promise, cancel, submitCode: vi.fn() };
    vi.spyOn(console, 'log')
        .mockImplementation(() => undefined);
    await import('./main.ts');
    expect(runtime.listen)
        .toBeDefined();
    expect(runtime.startLogin).not.toHaveBeenCalled();
    runtime.listen?.({ port: 3000 });
    await vi.waitFor(() => {
        expect(runtime.startLogin)
            .toHaveBeenCalledOnce();
    });
    process.listeners('SIGTERM')
        .filter(listener => !oldTerminate.includes(listener))
        .forEach((listener) => { listener('SIGTERM'); });
    expect(server.close)
        .toHaveBeenCalledOnce();
    expect(server.closeAllConnections)
        .toHaveBeenCalledOnce();
    expect(server.close.mock.invocationCallOrder[0])
        .toBeLessThan(server.closeAllConnections.mock.invocationCallOrder[0]!);
    server.emit('close');
    expect(cancel)
        .toHaveBeenCalledOnce();
    signInUrl.resolve('https://claude.ai/login');
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
    expect(runtime.post).not.toHaveBeenCalled();
    process.listeners('SIGINT')
        .filter(listener => !oldInterrupt.includes(listener))
        .forEach((listener) => { process.removeListener('SIGINT', listener); });
    process.listeners('SIGTERM')
        .filter(listener => !oldTerminate.includes(listener))
        .forEach((listener) => { process.removeListener('SIGTERM', listener); });
});
