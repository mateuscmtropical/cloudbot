// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../shared/chatTypes.ts';
import { renderMarkdown } from '../markdown.ts';
import type * as markdownTypes from '../markdown.ts';
import { ConversationView } from './ConversationView.tsx';

type MarkdownModule = typeof markdownTypes;

vi.mock('../markdown.ts', async (importOriginal) => {
    const actual = await importOriginal<MarkdownModule>();

    return { ...actual, renderMarkdown: vi.fn(actual.renderMarkdown) };
});

const stableActions = {
    onChoose: vi.fn(() => Promise.resolve()),
    onSubmitCode: vi.fn(),
    onSubmitSecret: vi.fn(() => Promise.resolve()),
    onOpenScreen: vi.fn(),
};
const noop = vi.fn();

function textMessage(sequence: number, role: ChatMessage['role']): ChatMessage {
    return { id: `m${String(sequence)}`, botId: 'bot-1', role, createdAt: sequence, sequence, body: { kind: 'text', text: `Message ${String(sequence)}` } };
}

function conversation(messages: ChatMessage[], draftText: string): ReactElement {
    return (
        <ConversationView
            bot={undefined}
            messages={messages}
            draftText={draftText}
            isRunning={false}
            attachments={[]}
            isUploading={false}
            onRemoveAttachment={noop}
            actions={stableActions}
            onOpenBotList={noop}
            onSend={noop}
            onStop={noop}
            onAttach={noop}
        />
    );
}

function enteringIds(container: HTMLElement): string[] {
    const entering = container.querySelectorAll<HTMLElement>('.is-entering');

    return Array.from(entering)
        .map(element => element.dataset.messageId ?? '');
}

afterEach(() => {
    cleanup();
    vi.mocked(renderMarkdown)
        .mockClear();
});

describe('ConversationView while a reply streams', () => {
    it('parses only the streamed draft again on each delta, not the stored messages', () => {
        const history = Array.from({ length: 20 }, (_unused, index) => textMessage(index + 1, index % 2 === 0 ? 'user' : 'assistant'));
        const { rerender } = render(conversation(history, 'Hel'));

        vi.mocked(renderMarkdown)
            .mockClear();
        rerender(conversation(history, 'Hello'));
        rerender(conversation(history, 'Hello there'));

        expect(vi.mocked(renderMarkdown).mock.calls)
            .toEqual([['Hello'], ['Hello there']]);
    });
});

describe('ConversationView message entry', () => {
    it('lets a live message rise in, and keeps a loaded page and a stored reply still', () => {
        const page = [textMessage(1, 'user'), textMessage(2, 'assistant')];
        const { container, rerender } = render(conversation([], ''));

        rerender(conversation(page, ''));

        expect(enteringIds(container))
            .toEqual([]);

        const withQuestion = [...page, textMessage(3, 'user')];

        rerender(conversation(withQuestion, ''));
        rerender(conversation([...withQuestion, textMessage(4, 'assistant')], ''));

        expect(enteringIds(container))
            .toEqual(['m3']);
    });
});
