// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary, ChatMessage } from '../../shared/chatTypes.ts';
import { createDraftStore, EMPTY_DRAFT } from '../draftStore.ts';
import type { DraftStore } from '../draftStore.ts';
import { renderDraftMarkdown, renderMarkdown } from '../markdown.ts';
import type * as markdownTypes from '../markdown.ts';
import { ConversationView } from './ConversationView.tsx';

type MarkdownModule = typeof markdownTypes;

vi.mock('../markdown.ts', async (importOriginal) => {
    const actual = await importOriginal<MarkdownModule>();

    return { ...actual, renderMarkdown: vi.fn(actual.renderMarkdown), renderDraftMarkdown: vi.fn(actual.renderDraftMarkdown) };
});

const stableActions = {
    onChoose: vi.fn(() => Promise.resolve()),
    onSubmitCode: vi.fn(),
    onSubmitSecret: vi.fn(() => Promise.resolve()),
    onOpenScreen: vi.fn(),
};
const noop = vi.fn();
const bot: BotSummary = {
    id: 'bot-1',
    name: 'CloudBot',
    title: 'Coworker',
    mascotColor: 'blue',
    mascotShape: 'puff',
    mascotEyes: 'smile', mascotWeather: 'auto', mascotBolt: 'down',
    lastMessagePreview: '',
    hasUnread: false,
    lastMessageSequence: 0,
};

function textMessage(sequence: number, role: ChatMessage['role']): ChatMessage {
    return { id: `m${String(sequence)}`, botId: 'bot-1', role, createdAt: sequence, sequence, body: { kind: 'text', text: `Message ${String(sequence)}` } };
}

function conversation(messages: ChatMessage[], draftStore?: DraftStore): ReactElement {
    return (
        <ConversationView
            bot={bot}
            messages={messages}
            draftStore={draftStore}
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

function setDraftText(store: DraftStore, text: string): void {
    act(() => {
        store.set({ botId: 'bot-1', text, afterSequence: 0 });
    });
}

afterEach(() => {
    cleanup();
    vi.mocked(renderMarkdown)
        .mockClear();
    vi.mocked(renderDraftMarkdown)
        .mockClear();
});

describe('ConversationView while a reply streams', () => {
    it('parses only the block still being written on each delta', () => {
        const history = Array.from({ length: 20 }, (_unused, index) => textMessage(index + 1, index % 2 === 0 ? 'user' : 'assistant'));
        const store = createDraftStore();

        render(conversation(history, store));
        setDraftText(store, 'First block\n\nSec');
        setDraftText(store, 'First block\n\nSecond\n');

        vi.mocked(renderMarkdown)
            .mockClear();
        vi.mocked(renderDraftMarkdown)
            .mockClear();
        setDraftText(store, 'First block\n\nSecond\nmore');

        expect(vi.mocked(renderMarkdown).mock.calls)
            .toEqual([]);
        expect(vi.mocked(renderDraftMarkdown).mock.calls)
            .toEqual([['Second\nmore']]);
    });

    it('shows the draft as an assistant bubble until the finished message replaces it', () => {
        const store = createDraftStore();
        const { container, rerender } = render(conversation([], store));

        setDraftText(store, 'Partial **reply**');

        expect(screen.getByText('reply').tagName)
            .toBe('STRONG');
        expect(container.querySelector('.message-assistant.is-draft'))
            .not.toBeNull();

        act(() => {
            store.set(EMPTY_DRAFT);
        });
        rerender(conversation([textMessage(1, 'assistant')], store));

        expect(container.querySelector('.is-draft'))
            .toBeNull();
    });

    it('shows only the draft of the bot on screen', () => {
        const store = createDraftStore({ botId: 'other-bot', text: 'Not here', afterSequence: 0 });
        const { container } = render(conversation([], store));

        expect(container.querySelector('.is-draft'))
            .toBeNull();
    });

    it('keeps a reader at the bottom as the draft grows, and leaves one who scrolled up', () => {
        const store = createDraftStore();
        const { container } = render(conversation([], store));
        const messageList = container.querySelector('.message-list');

        if (messageList === null) {
            throw new Error('The message list is missing');
        }

        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 900 });
        setDraftText(store, 'One');

        expect(messageList.scrollTop)
            .toBe(900);

        messageList.scrollTop = 100;
        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1200 });
        setDraftText(store, 'One two');

        expect(messageList.scrollTop)
            .toBe(100);
    });
});

describe('ConversationView message entry', () => {
    it('lets a live message rise in, and keeps a loaded page and a stored reply still', () => {
        const page = [textMessage(1, 'user'), textMessage(2, 'assistant')];
        const { container, rerender } = render(conversation([]));

        rerender(conversation(page));

        expect(enteringIds(container))
            .toEqual([]);

        const withQuestion = [...page, textMessage(3, 'user')];

        rerender(conversation(withQuestion));
        rerender(conversation([...withQuestion, textMessage(4, 'assistant')]));

        expect(enteringIds(container))
            .toEqual(['m3']);
    });
});
