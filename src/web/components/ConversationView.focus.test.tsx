// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../shared/chatTypes.ts';
import { ConversationView } from './ConversationView.tsx';
import type { ConversationViewProps } from './ConversationView.tsx';

function createMessage(id: string, sequence: number): ChatMessage {
    return { id, botId: 'bot-1', role: 'assistant', createdAt: 1, sequence, body: { kind: 'text', text: `Message ${id}` } };
}

function conversationElement(messages: ChatMessage[], focusMessageId: string | undefined, onFocusHandled: () => void, paging: Partial<ConversationViewProps> = {}): ReactElement {
    return (
        <ConversationView
            bot={undefined}
            messages={messages}
            isRunning={false}
            attachments={[]}
            isUploading={false}
            onRemoveAttachment={vi.fn()}
            actions={{ onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() }}
            onOpenBotList={vi.fn()}
            onSend={vi.fn()}
            onStop={vi.fn()}
            onAttach={vi.fn()}
            focusMessageId={focusMessageId}
            onFocusHandled={onFocusHandled}
            {...paging}
        />
    );
}

describe('ConversationView focus message', () => {
    const scrolledIds: (string | undefined)[] = [];

    beforeEach(() => {
        scrolledIds.length = 0;
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            value(this: HTMLElement) {
                scrolledIds.push(this.dataset.messageId);
            },
        });
    });

    afterEach(() => {
        cleanup();
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    });

    it('scrolls to the message a notification named and reports it handled', () => {
        const onFocusHandled = vi.fn();
        const messages = [createMessage('m1', 1), createMessage('m2', 2), createMessage('m3', 3)];

        render(conversationElement(messages, 'm2', onFocusHandled));

        expect(scrolledIds)
            .toEqual(['m2']);
        expect(onFocusHandled)
            .toHaveBeenCalledTimes(1);
    });

    it('loads older pages until a search hit shows, then scrolls to it', () => {
        const onFocusHandled = vi.fn();
        const onLoadOlder = vi.fn();
        const searchView = (messages: ChatMessage[], hasOlderMessages: boolean, isLoadingOlder: boolean): ReactElement => conversationElement(messages, 'm1', onFocusHandled, { focusSequence: 1, hasOlderMessages, isLoadingOlder, onLoadOlder });
        const view = render(searchView([createMessage('m5', 5)], true, false));

        expect(onLoadOlder)
            .toHaveBeenCalledTimes(1);

        view.rerender(searchView([createMessage('m5', 5)], true, true));

        expect(onFocusHandled)
            .not.toHaveBeenCalled();

        view.rerender(searchView([createMessage('m1', 1), createMessage('m5', 5)], false, false));

        expect(scrolledIds)
            .toEqual(['m1']);
        expect(onFocusHandled)
            .toHaveBeenCalled();
    });

    it('gives up on a search hit when the older page fails to load', () => {
        const onFocusHandled = vi.fn();
        const onLoadOlder = vi.fn();
        const searchView = (isLoadingOlder: boolean): ReactElement => conversationElement([createMessage('m5', 5)], 'm1', onFocusHandled, { focusSequence: 1, hasOlderMessages: true, isLoadingOlder, onLoadOlder });
        const view = render(searchView(false));

        view.rerender(searchView(true));
        view.rerender(searchView(false));

        expect(onLoadOlder)
            .toHaveBeenCalledTimes(1);
        expect(onFocusHandled)
            .toHaveBeenCalled();
    });

    it('reports a message that is not in the list as handled, without scrolling', () => {
        const onFocusHandled = vi.fn();

        render(conversationElement([createMessage('m1', 1)], 'old-message', onFocusHandled));

        expect(scrolledIds)
            .toEqual([]);
        expect(onFocusHandled)
            .toHaveBeenCalledTimes(1);
    });

    it('waits for the messages to load before it reports the message handled', () => {
        const onFocusHandled = vi.fn();
        const view = render(conversationElement([], 'm2', onFocusHandled));

        expect(onFocusHandled)
            .not.toHaveBeenCalled();

        view.rerender(conversationElement([createMessage('m1', 1), createMessage('m2', 2)], 'm2', onFocusHandled));

        expect(scrolledIds)
            .toEqual(['m2']);
        expect(onFocusHandled)
            .toHaveBeenCalledTimes(1);
    });

    it('does nothing when no message is named', () => {
        const onFocusHandled = vi.fn();

        render(conversationElement([createMessage('m1', 1)], undefined, onFocusHandled));

        expect(scrolledIds)
            .toEqual([]);
        expect(onFocusHandled)
            .not.toHaveBeenCalled();
    });
});
