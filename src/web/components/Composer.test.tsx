// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DraftAttachment } from './Composer.tsx';
import { Composer } from './Composer.tsx';

interface RenderOptions {
    isRunning?: boolean;
    isUploading?: boolean;
    attachments?: DraftAttachment[];
    onSend?: (text: string) => void;
    onRemoveAttachment?: (attachmentId: string) => void;
}

function renderComposer(options: RenderOptions = {}): HTMLTextAreaElement {
    render(
        <Composer
            botName="CloudBot"
            isRunning={options.isRunning ?? false}
            isUploading={options.isUploading ?? false}
            attachments={options.attachments ?? []}
            onSend={options.onSend ?? vi.fn()}
            onStop={vi.fn()}
            onAttach={vi.fn()}
            onRemoveAttachment={options.onRemoveAttachment ?? vi.fn()}
        />,
    );

    return screen.getByPlaceholderText<HTMLTextAreaElement>('Message CloudBot');
}

describe('Composer', () => {
    afterEach(() => {
        cleanup();
    });

    it('sends the draft when Enter is pressed', () => {
        const onSend = vi.fn();
        const textarea = renderComposer({ onSend });

        fireEvent.change(textarea, { target: { value: 'hello' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });

        expect(onSend)
            .toHaveBeenCalledWith('hello');
        expect(textarea.value)
            .toBe('');
    });

    it('keeps the draft and sends nothing when Shift+Enter is pressed', () => {
        const onSend = vi.fn();
        const textarea = renderComposer({ onSend });

        fireEvent.change(textarea, { target: { value: 'first line' } });
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

        expect(onSend)
            .not.toHaveBeenCalled();
        expect(textarea.value)
            .toBe('first line');
    });

    it('shows a stop button instead of send while a turn runs', () => {
        renderComposer({ isRunning: true });

        expect(screen.getByRole('button', { name: 'Stop' }))
            .toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Send' }))
            .toBeNull();
    });

    it('lists the attached files as chips and marks the ones still uploading', () => {
        renderComposer({
            attachments: [
                { id: '1', name: 'notes.txt', status: 'uploading' },
                { id: '2', name: 'photo.png', status: 'ready' },
            ],
        });

        expect(screen.getByText('notes.txt (uploading)'))
            .toBeTruthy();
        expect(screen.getByText('photo.png'))
            .toBeTruthy();
    });

    it('does not send while a file is still uploading', () => {
        const onSend = vi.fn();
        const textarea = renderComposer({ onSend, isUploading: true });

        fireEvent.change(textarea, { target: { value: 'read this' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });

        expect(onSend)
            .not.toHaveBeenCalled();
        const sendButton = screen.getByRole('button', { name: 'Send' });

        expect(sendButton.hasAttribute('disabled'))
            .toBe(true);
    });

    it('disables the attach button while a turn runs', () => {
        renderComposer({ isRunning: true });

        const attachButton = screen.getByRole('button', { name: 'Attach files' });

        expect(attachButton.hasAttribute('disabled'))
            .toBe(true);
    });

    it('removes a ready file through its remove button', () => {
        const onRemoveAttachment = vi.fn();

        renderComposer({
            attachments: [{ id: 'server-1', name: 'notes.txt', status: 'ready' }],
            onRemoveAttachment,
        });
        fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));

        expect(onRemoveAttachment)
            .toHaveBeenCalledWith('server-1');
    });
});
