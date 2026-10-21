import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ChoiceBody } from '../../shared/chatTypes.ts';
import { ApprovalGate } from './ApprovalGate.ts';
import type { ApprovalChat, ToolCallReviewer } from './ApprovalGate.ts';

const SEND_CALL = { toolName: 'send_email', input: { to: 'ana@example.com' } };

function buildMessage(id: string, body: ChoiceBody): ChatMessage {
    return { id, botId: 'bot-1', role: 'assistant', createdAt: 1, sequence: 1, body };
}

interface FakeChat {
    chat: ApprovalChat;
    posted: ChoiceBody[];
    closed: { messageId: string; body: ChoiceBody }[];
}

function createFakeChat(): FakeChat {
    const posted: ChoiceBody[] = [];
    const closed: { messageId: string; body: ChoiceBody }[] = [];
    const chat = {
        post: vi.fn((_botId: string, body: ChoiceBody) => {
            posted.push(body);

            return Promise.resolve(buildMessage(`message-${String(posted.length)}`, body));
        }),
        close: vi.fn((messageId: string, body: ChoiceBody) => {
            closed.push({ messageId, body });

            return Promise.resolve(buildMessage(messageId, body));
        }),
    };

    return { chat, posted, closed };
}

function createGate(reviewer: ToolCallReviewer, timeoutMs?: number): FakeChat & { gate: ApprovalGate } {
    const fake = createFakeChat();
    const timeoutOption = timeoutMs === undefined ? {} : { timeoutMs };
    const gate = new ApprovalGate({ chat: fake.chat, reviewer, ...timeoutOption });

    return { gate, ...fake };
}

describe('ApprovalGate', () => {
    it('lets an allowed call through without asking', async () => {
        const { gate, posted } = createGate(() => Promise.resolve({ decision: 'allow' }));

        const decision = await gate.review('bot-1', SEND_CALL, new AbortController().signal);

        expect(decision)
            .toEqual({ isAllowed: true });
        expect(posted)
            .toEqual([]);
    });

    it('refuses a denied call and gives the reason', async () => {
        const { gate, posted } = createGate(() => Promise.resolve({ decision: 'deny', reason: 'Not on the list.' }));

        const decision = await gate.review('bot-1', SEND_CALL, new AbortController().signal);

        expect(decision)
            .toEqual({ isAllowed: false, reason: 'Not on the list.' });
        expect(posted)
            .toEqual([]);
    });

    it('waits for the owner and runs the call after Approve', async () => {
        const { gate, posted, closed } = createGate(() => Promise.resolve({ decision: 'ask', summary: 'Send an email to Ana' }));
        const pending = gate.review('bot-1', SEND_CALL, new AbortController().signal);

        await vi.waitFor(() => {
            expect(posted)
                .toHaveLength(1);
        });

        expect(posted[0]?.prompt)
            .toContain('Send an email to Ana');
        expect(posted[0]?.isApproval)
            .toBe(true);
        expect(gate.isPending('message-1'))
            .toBe(true);

        const answered = await gate.answer('bot-1', 'message-1', 'approve');

        expect(answered?.body)
            .toMatchObject({ chosenId: 'approve' });
        await expect(pending)
            .resolves.toEqual({ isAllowed: true });
        expect(closed)
            .toHaveLength(1);
        expect(gate.isPending('message-1'))
            .toBe(false);
    });

    it('refuses the call after Deny', async () => {
        const { gate, posted } = createGate(() => Promise.resolve({ decision: 'ask', summary: 'Buy a ticket' }));
        const pending = gate.review('bot-1', SEND_CALL, new AbortController().signal);

        await vi.waitFor(() => {
            expect(posted)
                .toHaveLength(1);
        });
        await gate.answer('bot-1', 'message-1', 'deny');

        await expect(pending)
            .resolves.toMatchObject({ isAllowed: false });
    });

    it('treats a stop as Deny and closes the question', async () => {
        const { gate, posted, closed } = createGate(() => Promise.resolve({ decision: 'ask', summary: 'Book a room' }));
        const abortController = new AbortController();
        const pending = gate.review('bot-1', SEND_CALL, abortController.signal);

        await vi.waitFor(() => {
            expect(posted)
                .toHaveLength(1);
        });
        abortController.abort();

        await expect(pending)
            .resolves.toMatchObject({ isAllowed: false });
        expect(closed[0]?.body.chosenId)
            .toBe('deny');
        expect(gate.isPending('message-1'))
            .toBe(false);
    });

    it('does not post a question for a turn that already stopped', async () => {
        const { gate, posted } = createGate(() => Promise.resolve({ decision: 'ask', summary: 'Book a room' }));
        const abortController = new AbortController();

        abortController.abort();

        const decision = await gate.review('bot-1', SEND_CALL, abortController.signal);

        expect(decision)
            .toMatchObject({ isAllowed: false });
        expect(posted)
            .toEqual([]);
    });

    it('refuses the call when nobody answers in time', async () => {
        const { gate, closed } = createGate(() => Promise.resolve({ decision: 'ask', summary: 'Pay the bill' }), 10);

        const decision = await gate.review('bot-1', SEND_CALL, new AbortController().signal);

        expect(decision)
            .toMatchObject({ isAllowed: false });
        expect(closed[0]?.body.chosenId)
            .toBe('deny');
    });

    it('asks the owner when the reviewer fails', async () => {
        const { gate, posted } = createGate(() => Promise.reject(new Error('boom')));
        const pending = gate.review('bot-1', SEND_CALL, new AbortController().signal);

        await vi.waitFor(() => {
            expect(posted)
                .toHaveLength(1);
        });
        await gate.answer('bot-1', 'message-1', 'deny');
        await pending;
    });

    it('ignores an answer for another bot, an unknown choice and a second answer', async () => {
        const { gate, posted } = createGate(() => Promise.resolve({ decision: 'ask', summary: 'Send it' }));
        const pending = gate.review('bot-1', SEND_CALL, new AbortController().signal);

        await vi.waitFor(() => {
            expect(posted)
                .toHaveLength(1);
        });

        await expect(gate.answer('bot-2', 'message-1', 'approve'))
            .resolves.toBeUndefined();
        await expect(gate.answer('bot-1', 'message-1', 'maybe'))
            .resolves.toBeUndefined();
        await gate.answer('bot-1', 'message-1', 'approve');
        await expect(gate.answer('bot-1', 'message-1', 'deny'))
            .resolves.toBeUndefined();
        await expect(pending)
            .resolves.toEqual({ isAllowed: true });
    });

    it('keeps the question to one short line', async () => {
        const longSummary = `Send\n   this ${'x'.repeat(500)}`;
        const { gate, posted } = createGate(() => Promise.resolve({ decision: 'ask', summary: longSummary }), 10);

        await gate.review('bot-1', SEND_CALL, new AbortController().signal);

        expect(posted[0]?.prompt)
            .not.toContain('\n');
        expect(posted[0]?.prompt.length)
            .toBeLessThan(400);
    });
});
