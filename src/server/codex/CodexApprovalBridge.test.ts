import { describe, expect, it, vi } from 'vitest';

import type { ToolCall, ToolCallDecision } from '../agent/AgentRunner.ts';
import { CodexApprovalBridge } from './CodexApprovalBridge.ts';

const THREAD_ID = 'thread-1';
const TURN_ID = 'turn-1';

type Review = (call: ToolCall, signal: AbortSignal) => Promise<ToolCallDecision>;

function allowing(): ReturnType<typeof vi.fn<Review>> {
    return vi.fn<Review>(() => Promise.resolve({ isAllowed: true }));
}

function refusing(): ReturnType<typeof vi.fn<Review>> {
    return vi.fn<Review>(() => Promise.resolve({ isAllowed: false, reason: 'No.' }));
}

// The shapes below are what codex-cli 0.163.0 sent in a probe against a fake model server.
function commandRequest(overrides: Record<string, unknown> = {}): { id: number; method: string; params: Record<string, unknown> } {
    return {
        id: 0,
        method: 'item/commandExecution/requestApproval',
        params: {
            kind: 'command',
            threadId: THREAD_ID,
            turnId: TURN_ID,
            itemId: 'call_1',
            startedAtMs: 1,
            environmentId: 'local',
            command: '/bin/bash -lc \'echo hi > made.txt\'',
            cwd: '/work',
            ...overrides,
        },
    };
}

function itemStarted(item: Record<string, unknown>, turnId = TURN_ID): { method: string; params: Record<string, unknown> } {
    return { method: 'item/started', params: { item, threadId: THREAD_ID, turnId, startedAtMs: 1 } };
}

function itemCompleted(item: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
    return { method: 'item/completed', params: { item, threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 2 } };
}

const FILE_ITEM = { type: 'fileChange', id: 'call_2', changes: [{ path: '/work/made.txt', kind: { type: 'add' }, diff: 'hello\n' }], status: 'inProgress' };
const MCP_ITEM = { type: 'mcpToolCall', id: 'call_3', server: 'cloud', tool: 'peek', status: 'inProgress', arguments: { note: 'secret' } };

function fileRequest(overrides: Record<string, unknown> = {}): { id: number; method: string; params: Record<string, unknown> } {
    return { id: 1, method: 'item/fileChange/requestApproval', params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'call_2', startedAtMs: 1, reason: null, grantRoot: null, ...overrides } };
}

function elicitation(overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): { id: number; method: string; params: Record<string, unknown> } {
    return {
        id: 2,
        method: 'mcpServer/elicitation/request',
        params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            serverName: 'cloud',
            mode: 'form',
            _meta: { codex_approval_kind: 'mcp_tool_call', tool_description: 'Reads a note.', tool_params: { note: 'secret' }, ...meta },
            message: 'Allow the cloud MCP server to run tool "peek"?',
            requestedSchema: { type: 'object', properties: {} },
            ...overrides,
        },
    };
}

const SIGNAL = new AbortController().signal;

describe('CodexApprovalBridge commands', () => {
    it('reviews a command as Bash with its whole command line, and accepts only on allow', async () => {
        const review = allowing();
        const bridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: review });

        const answer = await bridge.answerRequest(commandRequest(), SIGNAL);

        expect(review)
            .toHaveBeenCalledWith({ toolName: 'Bash', input: { command: '/bin/bash -lc \'echo hi > made.txt\'', cwd: '/work' } }, expect.any(AbortSignal));
        expect(answer)
            .toEqual({ result: { decision: 'accept' } });
    });

    it('declines a command the review refuses', async () => {
        const bridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: refusing() });

        await expect(bridge.answerRequest(commandRequest(), SIGNAL))
            .resolves.toEqual({ result: { decision: 'decline' } });
    });

    it('declines without a review: another thread, stdin input, a network grant or a missing command', async () => {
        const review = allowing();
        const bridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: review });
        const requests = [
            commandRequest({ threadId: 'thread-2' }),
            commandRequest({ kind: 'writeStdin', itemId: 'call_a' }),
            commandRequest({ networkApprovalContext: { host: 'example.com' }, itemId: 'call_b' }),
            commandRequest({ command: undefined, itemId: 'call_c' }),
        ];

        const answerPromises = requests.map(request => bridge.answerRequest(request, SIGNAL));
        const answers = await Promise.all(answerPromises);

        expect(answers)
            .toEqual(requests.map(() => ({ result: { decision: 'decline' } })));
        expect(review)
            .not.toHaveBeenCalled();
    });

    it('decides one command item once', async () => {
        const review = allowing();
        const bridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: review });

        await bridge.answerRequest(commandRequest(), SIGNAL);
        const second = await bridge.answerRequest(commandRequest(), SIGNAL);

        expect(second)
            .toEqual({ result: { decision: 'decline' } });
        expect(review)
            .toHaveBeenCalledTimes(1);
    });

    it('declines when the review throws, when the turn stops and when the review takes too long', async () => {
        const throwing = vi.fn((): Promise<ToolCallDecision> => Promise.reject(new Error('review down')));
        const hanging = vi.fn((): Promise<ToolCallDecision> => new Promise<ToolCallDecision>(() => undefined));
        const controller = new AbortController();
        const throwingBridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: throwing });
        const stoppedBridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: hanging });
        const slowBridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: hanging, reviewTimeoutMs: 10 });

        const thrown = await throwingBridge.answerRequest(commandRequest(), SIGNAL);
        const stoppedPromise = stoppedBridge.answerRequest(commandRequest(), controller.signal);

        controller.abort();
        const stopped = await stoppedPromise;
        const timedOut = await slowBridge.answerRequest(commandRequest(), SIGNAL);

        expect([thrown, stopped, timedOut])
            .toEqual([
                { result: { decision: 'decline' } },
                { result: { decision: 'decline' } },
                { result: { decision: 'decline' } },
            ]);
    });
});

describe('CodexApprovalBridge file changes', () => {
    it('reviews a patch as Edit with the changes from its item/started notification', async () => {
        const review = allowing();
        const bridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: review });

        bridge.noteNotification(itemStarted(FILE_ITEM));
        const answer = await bridge.answerRequest(fileRequest(), SIGNAL);

        expect(review)
            .toHaveBeenCalledWith({ toolName: 'Edit', input: { changes: FILE_ITEM.changes } }, expect.any(AbortSignal));
        expect(answer)
            .toEqual({ result: { decision: 'accept' } });
    });

    it('declines a patch whose item was never reported, or asks for write access to a root', async () => {
        const review = allowing();
        const bridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: review });

        const unseen = await bridge.answerRequest(fileRequest(), SIGNAL);

        bridge.noteNotification(itemStarted(FILE_ITEM));
        const withRoot = await bridge.answerRequest(fileRequest({ grantRoot: '/' }), SIGNAL);

        expect([unseen, withRoot])
            .toEqual([{ result: { decision: 'decline' } }, { result: { decision: 'decline' } }]);
        expect(review)
            .not.toHaveBeenCalled();
    });

    it('declines a patch whose item came from another turn', async () => {
        const review = allowing();
        const bridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: review });

        bridge.noteNotification(itemStarted(FILE_ITEM, 'turn-0'));

        await expect(bridge.answerRequest(fileRequest(), SIGNAL))
            .resolves.toEqual({ result: { decision: 'decline' } });
        expect(review)
            .not.toHaveBeenCalled();
    });
});

describe('CodexApprovalBridge MCP tool calls', () => {
    it('reviews an MCP call with the server, tool and arguments of its item', async () => {
        const review = allowing();
        const bridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: review });

        bridge.noteNotification(itemStarted(MCP_ITEM));
        const answer = await bridge.answerRequest(elicitation(), SIGNAL);

        expect(review)
            .toHaveBeenCalledWith({ toolName: 'mcp__cloud__peek', input: { note: 'secret' } }, expect.any(AbortSignal));
        expect(answer)
            .toEqual({ result: { action: 'accept', content: {}, _meta: null } });
    });

    it('declines when the arguments differ from the item, or when two calls of the server wait at once', async () => {
        const review = allowing();
        const bridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: review });

        bridge.noteNotification(itemStarted(MCP_ITEM));
        const changed = await bridge.answerRequest(elicitation({}, { tool_params: { note: 'other' } }), SIGNAL);

        bridge.noteNotification(itemStarted({ ...MCP_ITEM, id: 'call_4' }));
        const ambiguous = await bridge.answerRequest(elicitation(), SIGNAL);

        expect([changed, ambiguous])
            .toEqual([
                { result: { action: 'decline', content: null, _meta: null } },
                { result: { action: 'decline', content: null, _meta: null } },
            ]);
        expect(review)
            .not.toHaveBeenCalled();
    });

    it('forgets a finished item, so it never makes a later call ambiguous', async () => {
        const review = allowing();
        const bridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: review });
        // read_mcp_resource is reported as an MCP item and asks nothing (codex-cli 0.163.0).
        const resourceRead = { ...MCP_ITEM, id: 'call_r', tool: 'read_mcp_resource', arguments: { server: 'cloud', uri: 'x' } };

        bridge.noteNotification(itemStarted(resourceRead));
        bridge.noteNotification(itemCompleted(resourceRead));
        bridge.noteNotification(itemStarted(MCP_ITEM));

        await expect(bridge.answerRequest(elicitation(), SIGNAL))
            .resolves.toEqual({ result: { action: 'accept', content: {}, _meta: null } });
    });

    it('declines an elicitation that is not a tool approval, such as a form or a URL from the server', async () => {
        const review = allowing();
        const bridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: review });

        bridge.noteNotification(itemStarted(MCP_ITEM));
        const plainForm = await bridge.answerRequest(elicitation({}, { codex_approval_kind: undefined }), SIGNAL);
        const urlMode = await bridge.answerRequest(elicitation({ mode: 'url', url: 'https://example.test', elicitationId: 'e1' }), SIGNAL);

        expect([plainForm, urlMode])
            .toEqual([
                { result: { action: 'decline', content: null, _meta: null } },
                { result: { action: 'decline', content: null, _meta: null } },
            ]);
        expect(review)
            .not.toHaveBeenCalled();
    });
});

describe('CodexApprovalBridge other requests', () => {
    it.each([
        'item/permissions/requestApproval',
        'item/tool/requestUserInput',
        'item/tool/call',
        'account/chatgptAuthTokens/refresh',
        'attestation/generate',
        'applyPatchApproval',
        'execCommandApproval',
        'some/new/request',
    ])('answers %s with an error and never reviews it', async (method) => {
        const review = allowing();
        const bridge = new CodexApprovalBridge({ threadId: THREAD_ID, reviewToolCall: review });

        const answer = await bridge.answerRequest({ id: 9, method, params: { threadId: THREAD_ID } }, SIGNAL);

        expect(answer)
            .toMatchObject({ error: { code: -32601 } });
        expect(review)
            .not.toHaveBeenCalled();
    });
});
