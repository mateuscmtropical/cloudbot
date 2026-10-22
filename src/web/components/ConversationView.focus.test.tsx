// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../shared/chatTypes.ts';
import { ConversationView } from './ConversationView.tsx';

function createMessage(id: string, sequence: number): ChatMessage {
    return { id, botId: 'bot-1', role: 'assistant', createdAt: 1, sequence, body: { kind: 'text', text: `Message ${id}` } };
}

function conversationElement(messages: ChatMessage[], focusMessageId: string | undefined, onFocusHandled: () => void): ReactElement {
    return (
        <ConversationView
            bot={undefined}
            messages={messages}
            draftText=""
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
