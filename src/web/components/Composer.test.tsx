// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Composer } from './Composer.tsx';

function renderComposer(onSend: (text: string) => void): HTMLTextAreaElement {
    render(
        <Composer
            botName="CloudBot"
            isRunning={false}
            onSend={onSend}
            onStop={vi.fn()}
            onAttach={vi.fn()}
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
        const textarea = renderComposer(onSend);

        fireEvent.change(textarea, { target: { value: 'hello' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });

        expect(onSend)
            .toHaveBeenCalledWith('hello');
        expect(textarea.value)
            .toBe('');
    });

    it('keeps the draft and sends nothing when Shift+Enter is pressed', () => {
        const onSend = vi.fn();
        const textarea = renderComposer(onSend);

        fireEvent.change(textarea, { target: { value: 'first line' } });
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

        expect(onSend)
            .not.toHaveBeenCalled();
        expect(textarea.value)
            .toBe('first line');
    });

    it('shows a stop button instead of send while a turn runs', () => {
        render(
            <Composer
                botName="CloudBot"
                isRunning={true}
                onSend={vi.fn()}
                onStop={vi.fn()}
                onAttach={vi.fn()}
            />,
        );

        expect(screen.getByRole('button', { name: 'Stop' }))
            .toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Send' }))
            .toBeNull();
    });
});
