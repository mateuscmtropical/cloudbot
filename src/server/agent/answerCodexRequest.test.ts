import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ToolCall, ToolCallDecision } from './AgentRunner.ts';
import { answerCodexRequest, unwrapShellCommand } from './answerCodexRequest.ts';
import type { CodexRequestContext } from './answerCodexRequest.ts';
import type { CodexFileChangeItem, CodexThreadItem } from './codexProtocol.ts';

const TEST_FOLDER = mkdtempSync(join(tmpdir(), 'cloudbot-codex-request-'));
const WORKSPACE_DIR = join(TEST_FOLDER, 'work');
const CODEX_HOME = join(TEST_FOLDER, 'codex-home');

mkdirSync(WORKSPACE_DIR);
mkdirSync(CODEX_HOME);

function makeContext(decide: (call: ToolCall) => ToolCallDecision, items: CodexThreadItem[] = []): CodexRequestContext & { calls: ToolCall[] } {
    const calls: ToolCall[] = [];

    return {
        calls,
        reviewToolCall: (call) => {
            calls.push(call);

            return Promise.resolve(decide(call));
        },
        signal: new AbortController().signal,
        findItem: itemId => items.find(item => item.id === itemId),
        timeoutMs: 1000,
        workspaceDir: WORKSPACE_DIR,
        codexHome: CODEX_HOME,
        hasStepsLeft: () => true,
    };
}

const allow = (): ToolCallDecision => ({ isAllowed: true });
const deny = (): ToolCallDecision => ({ isAllowed: false, reason: 'No.' });

function commandRequest(command: string, kind = 'command', extra: Record<string, unknown> = {}): unknown {
    return { kind, threadId: 't', turnId: 'u', itemId: 'call_1', startedAtMs: 1, environmentId: 'local', command, cwd: WORKSPACE_DIR, proposedExecpolicyAmendment: ['ls'], ...extra };
}

describe('unwrapShellCommand', () => {
    it('reads the command inside the login shell Codex wraps it in, quoted or as one plain word', () => {
        expect(unwrapShellCommand('/bin/bash -lc \'cat /etc/hostname\''))
            .toBe('cat /etc/hostname');
        expect(unwrapShellCommand('/bin/bash -lc ls'))
            .toBe('ls');
        expect(unwrapShellCommand('/bin/zsh -lc \'rm -rf /\''))
            .toBe('rm -rf /');
    });

    it('keeps a command whole when the inner text cannot be read back exactly', () => {
        const nested = '/bin/bash -lc \'echo \'\\\'\'hi\'\\\'\'\'';

        expect(unwrapShellCommand(nested))
            .toBe(nested);
        expect(unwrapShellCommand('/bin/bash -lc rm -rf /'))
            .toBe('/bin/bash -lc rm -rf /');
        expect(unwrapShellCommand('ls -la'))
            .toBe('ls -la');
    });
});

describe('answerCodexRequest', () => {
    it('sends a command to the review as Bash and accepts it only when allowed', async () => {
        const allowing = makeContext(allow);
        const denying = makeContext(deny);

        const accepted = await answerCodexRequest('item/commandExecution/requestApproval', commandRequest('/bin/bash -lc \'git status\''), allowing);
        const declined = await answerCodexRequest('item/commandExecution/requestApproval', commandRequest('/bin/bash -lc \'git push\''), denying);

        expect(accepted)
            .toEqual({ result: { decision: 'accept' } });
        expect(declined)
            .toEqual({ result: { decision: 'decline' } });
        expect(allowing.calls)
            .toEqual([{ toolName: 'Bash', input: { command: 'git status' } }]);
    });

    it('declines a write to the input of a running command and a request without a command, without a review', async () => {
        const context = makeContext(allow);

        const stdin = await answerCodexRequest('item/commandExecution/requestApproval', commandRequest('y', 'writeStdin'), context);
        const empty = await answerCodexRequest('item/commandExecution/requestApproval', { kind: 'command' }, context);

        expect([stdin, empty])
            .toEqual([{ result: { decision: 'decline' } }, { result: { decision: 'decline' } }]);
        expect(context.calls)
            .toEqual([]);
    });

    it('declines when the turn stopped before or during the review, even when the review allows', async () => {
        const stopped = new AbortController();

        stopped.abort();
        const before = { ...makeContext(allow), signal: stopped.signal };
        const during = new AbortController();
        const stopsDuring = {
            ...makeContext(allow),
            signal: during.signal,
            reviewToolCall: () => {
                during.abort();

                return Promise.resolve<ToolCallDecision>({ isAllowed: true });
            },
        };

        const early = await answerCodexRequest('item/commandExecution/requestApproval', commandRequest('ls'), before);
        const late = await answerCodexRequest('item/commandExecution/requestApproval', commandRequest('ls'), stopsDuring);

        expect([early, late])
            .toEqual([{ result: { decision: 'decline' } }, { result: { decision: 'decline' } }]);
        expect(before.calls)
            .toEqual([]);
    });

    it('declines a patch that Codex replaced while it was reviewed', async () => {
        const reviewed: CodexThreadItem = { type: 'fileChange', id: 'call_2', status: 'inProgress', changes: [{ path: join(WORKSPACE_DIR, 'a.txt'), kind: { type: 'add' }, diff: 'safe\n' }] };
        const newer: CodexThreadItem = { type: 'fileChange', id: 'call_2', status: 'inProgress', changes: [{ path: join(WORKSPACE_DIR, 'a.txt'), kind: { type: 'add' }, diff: 'other\n' }] };
        let current = reviewed;
        const context = {
            ...makeContext(allow),
            findItem: () => current,
            reviewToolCall: () => {
                current = newer;

                return Promise.resolve<ToolCallDecision>({ isAllowed: true });
            },
        };

        const answer = await answerCodexRequest('item/fileChange/requestApproval', { itemId: 'call_2', reason: null, grantRoot: null }, context);

        expect(answer)
            .toEqual({ result: { decision: 'decline' } });
    });

    it('declines a retry outside the sandbox and a network grant without a review', async () => {
        const context = makeContext(allow);
        const requests = [
            commandRequest('npm install', 'command', { reason: 'Run again without the sandbox?' }),
            commandRequest('curl x', 'command', { networkApprovalContext: { host: 'attacker.example' } }),
            commandRequest('curl x', 'command', { proposedNetworkPolicyAmendments: [{ host: 'attacker.example' }] }),
        ];

        const answers = await Promise.all(requests.map(params => answerCodexRequest('item/commandExecution/requestApproval', params, context)));

        expect(answers)
            .toEqual([{ result: { decision: 'decline' } }, { result: { decision: 'decline' } }, { result: { decision: 'decline' } }]);
        expect(context.calls)
            .toEqual([]);
    });

    it('declines a command that names the Codex home or a project .codex folder without a review', async () => {
        const context = makeContext(allow);
        const requests = [
            commandRequest(`/bin/bash -lc 'cat ${join(CODEX_HOME, 'auth.json')}'`),
            commandRequest(`/bin/bash -lc 'cat ${join(WORKSPACE_DIR, '.codex', 'config.toml')}'`),
            commandRequest('cat .codex/config.toml'),
            commandRequest('/bin/bash -lc \'cat config.toml\'', 'command', { cwd: join(WORKSPACE_DIR, '.codex') }),
        ];

        const answers = await Promise.all(requests.map(params => answerCodexRequest('item/commandExecution/requestApproval', params, context)));

        expect(answers)
            .toEqual([{ result: { decision: 'decline' } }, { result: { decision: 'decline' } }, { result: { decision: 'decline' } }, { result: { decision: 'decline' } }]);
        // The floor runs before the review, so a command that names these folders never reaches it.
        expect(context.calls)
            .toEqual([]);
    });

    it('declines a file change inside the Codex home or a project .codex folder without a review', async () => {
        const items: CodexFileChangeItem[] = [
            { type: 'fileChange', id: 'home', status: 'inProgress', changes: [{ path: join(CODEX_HOME, 'config.toml'), kind: { type: 'update', move_path: null }, diff: '-a\n+b\n' }] },
            { type: 'fileChange', id: 'move', status: 'inProgress', changes: [{ path: join(WORKSPACE_DIR, 'safe.txt'), kind: { type: 'update', move_path: join(CODEX_HOME, 'auth.json') }, diff: '-a\n+b\n' }] },
            { type: 'fileChange', id: 'project', status: 'inProgress', changes: [{ path: join(WORKSPACE_DIR, '.codex', 'config.toml'), kind: { type: 'add' }, diff: 'x\n' }] },
            { type: 'fileChange', id: 'relative', status: 'inProgress', changes: [{ path: 'src/../.codex/config.toml', kind: { type: 'add' }, diff: 'x\n' }] },
        ];
        const context = makeContext(allow, items);

        const answers = await Promise.all(items.map(item => answerCodexRequest('item/fileChange/requestApproval', { itemId: item.id }, context)));

        expect(answers)
            .toEqual([{ result: { decision: 'decline' } }, { result: { decision: 'decline' } }, { result: { decision: 'decline' } }, { result: { decision: 'decline' } }]);
        expect(context.calls)
            .toEqual([]);
    });

    it.skipIf(process.platform === 'win32')('declines a file change that reaches the Codex home through a symlink', async () => {
        const folder = mkdtempSync(join(tmpdir(), 'cloudbot-codex-link-'));
        const workspace = join(folder, 'work');
        const codexHome = join(folder, 'codex-home');

        mkdirSync(workspace);
        mkdirSync(codexHome);
        symlinkSync(codexHome, join(workspace, 'link'), 'dir');

        const item: CodexFileChangeItem = {
            type: 'fileChange',
            id: 'link',
            status: 'inProgress',
            changes: [{ path: join(workspace, 'link', 'config.toml'), kind: { type: 'add' }, diff: 'x\n' }],
        };
        const context = { ...makeContext(allow, [item]), workspaceDir: workspace, codexHome };

        const answer = await answerCodexRequest('item/fileChange/requestApproval', { itemId: 'link' }, context);

        expect(answer)
            .toEqual({ result: { decision: 'decline' } });
        expect(context.calls)
            .toEqual([]);
    });

    it.skipIf(process.platform === 'win32')('declines a file change whose real path cannot be read', async () => {
        const folder = mkdtempSync(join(tmpdir(), 'cloudbot-codex-link-'));
        const workspace = join(folder, 'work');
        const codexHome = join(folder, 'codex-home');

        mkdirSync(workspace);
        mkdirSync(codexHome);
        symlinkSync(join(codexHome, 'missing.toml'), join(workspace, 'broken.toml'), 'file');

        const item: CodexFileChangeItem = {
            type: 'fileChange',
            id: 'broken',
            status: 'inProgress',
            changes: [{ path: join(workspace, 'broken.toml'), kind: { type: 'add' }, diff: 'x\n' }],
        };
        const context = { ...makeContext(allow, [item]), workspaceDir: workspace, codexHome };

        const answer = await answerCodexRequest('item/fileChange/requestApproval', { itemId: 'broken' }, context);

        expect(answer)
            .toEqual({ result: { decision: 'decline' } });
        expect(context.calls)
            .toEqual([]);
    });

    it('shows the folder of a command that runs outside the workspace', async () => {
        const context = makeContext(allow);

        await answerCodexRequest('item/commandExecution/requestApproval', commandRequest('/bin/bash -lc \'rm -rf *\'', 'command', { cwd: '/home/bot\'s' }), context);

        expect(context.calls)
            .toEqual([{ toolName: 'Bash', input: { command: 'cd \'/home/bot\'\\\'\'s\' && rm -rf *' } }]);
    });

    it('declines a command or a patch once the turn has no steps left', async () => {
        const context = { ...makeContext(allow), hasStepsLeft: () => false };

        const command = await answerCodexRequest('item/commandExecution/requestApproval', commandRequest('ls'), context);
        const patch = await answerCodexRequest('item/fileChange/requestApproval', { itemId: 'call_2', reason: null, grantRoot: null }, context);

        expect([command, patch])
            .toEqual([{ result: { decision: 'decline' } }, { result: { decision: 'decline' } }]);
    });

    it('declines when the review throws or does not answer in time', async () => {
        const throwing = { ...makeContext(allow), reviewToolCall: () => Promise.reject(new Error('down')) };
        let reviewSignal: AbortSignal | undefined;
        const hanging = {
            ...makeContext(allow),
            timeoutMs: 10,
            reviewToolCall: (_call: ToolCall, signal: AbortSignal) => {
                reviewSignal = signal;

                return new Promise<ToolCallDecision>(() => undefined);
            },
        };

        const thrown = await answerCodexRequest('item/commandExecution/requestApproval', commandRequest('ls'), throwing);
        const late = await answerCodexRequest('item/commandExecution/requestApproval', commandRequest('ls'), hanging);

        expect([thrown, late])
            .toEqual([{ result: { decision: 'decline' } }, { result: { decision: 'decline' } }]);
        // The review is told to stop, so a waiting approval card closes.
        expect(reviewSignal?.aborted)
            .toBe(true);
    });

    it('reviews each file of a patch as a Write or an Edit, and a move as a write to the new path', async () => {
        const item: CodexThreadItem = {
            type: 'fileChange',
            id: 'call_2',
            status: 'inProgress',
            changes: [
                { path: '/w/new.txt', kind: { type: 'add' }, diff: 'hello\n' },
                { path: '/w/old.txt', kind: { type: 'update', move_path: '/w/moved.txt' }, diff: '-a\n+b\n' },
            ],
        };
        const context = makeContext(allow, [item]);

        const answer = await answerCodexRequest('item/fileChange/requestApproval', { threadId: 't', turnId: 'u', itemId: 'call_2', startedAtMs: 1 }, context);

        expect(answer)
            .toEqual({ result: { decision: 'accept' } });
        expect(context.calls)
            .toEqual([
                { toolName: 'Write', input: { file_path: '/w/new.txt', content: 'hello\n' } },
                { toolName: 'Edit', input: { file_path: '/w/old.txt', diff: '-a\n+b\n', change: 'update' } },
                { toolName: 'Write', input: { file_path: '/w/moved.txt', content: '-a\n+b\n' } },
            ]);
    });

    it('stops at the first refused file of a patch, and declines a patch it has no changes for or that asks for a grant root', async () => {
        const item: CodexThreadItem = {
            type: 'fileChange',
            id: 'call_2',
            status: 'inProgress',
            changes: [
                { path: '/w/a.txt', kind: { type: 'delete' }, diff: '' },
                { path: '/w/b.txt', kind: { type: 'add' }, diff: 'b\n' },
            ],
        };
        const context = makeContext(deny, [item]);

        const refused = await answerCodexRequest('item/fileChange/requestApproval', { itemId: 'call_2' }, context);
        const unknown = await answerCodexRequest('item/fileChange/requestApproval', { itemId: 'call_9' }, context);
        const allowing = makeContext(allow, [item]);
        const rooted = await answerCodexRequest('item/fileChange/requestApproval', { itemId: 'call_2', reason: null, grantRoot: '/' }, allowing);

        expect([refused, unknown, rooted])
            .toEqual([{ result: { decision: 'decline' } }, { result: { decision: 'decline' } }, { result: { decision: 'decline' } }]);
        expect(context.calls)
            .toHaveLength(1);
        expect(allowing.calls)
            .toEqual([]);
    });

    it('declines every MCP question and refuses requests it does not know, such as a token refresh', async () => {
        const review = vi.fn(allow);
        const context = makeContext(review);

        const elicitation = await answerCodexRequest('mcpServer/elicitation/request', { serverName: 'x', mode: 'form' }, context);
        const legacy = await answerCodexRequest('execCommandApproval', {}, context);
        const refresh = await answerCodexRequest('account/chatgptAuthTokens/refresh', {}, context);
        const question = await answerCodexRequest('item/tool/requestUserInput', {}, context);

        expect(elicitation)
            .toEqual({ result: { action: 'decline', content: null, _meta: null } });
        expect(legacy)
            .toEqual({ result: { decision: 'abort' } });
        expect(refresh)
            .toMatchObject({ error: { code: -32601 } });
        expect(question)
            .toMatchObject({ error: { code: -32601 } });
        expect(review)
            .not.toHaveBeenCalled();
    });
});
