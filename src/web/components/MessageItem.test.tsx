// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageBody } from '../../shared/chatTypes.ts';
import { MessageItem } from './MessageItem.tsx';

describe('answered setup messages', () => {
    afterEach(cleanup);

    it.each<MessageBody>([
        { kind: 'choice', prompt: 'Connect Claude', options: [{ id: 'apiKey', label: 'API key' }], chosenId: 'apiKey' },
        { kind: 'codeField', prompt: 'Paste code', placeholder: 'Code', submitted: true },
        { kind: 'secureForm', prompt: 'Paste key', secretName: 'ANTHROPIC_API_KEY', submitted: true },
    ])('disables an answered $kind message loaded from the server', (body) => {
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()) };
        const message = { id: 'setup', botId: 'bot', role: 'assistant' as const, sequence: 1, createdAt: 1, body };

        render(<MessageItem message={message} actions={actions} />);
        screen.queryAllByRole<HTMLButtonElement>('button')
            .forEach((button) => {
                expect(button.disabled)
                    .toBe(true);
                fireEvent.click(button);
            });
        expect(screen.queryByRole('textbox'))
            .toBeNull();
        expect(document.querySelector('input'))
            .toBeNull();
        expect(actions.onChoose).not.toHaveBeenCalled();
        expect(actions.onSubmitCode).not.toHaveBeenCalled();
        expect(actions.onSubmitSecret).not.toHaveBeenCalled();
    });
    it('offers subscription from the API key form', () => {
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()) };
        const body: MessageBody = { kind: 'secureForm', prompt: 'Add key', secretName: 'ANTHROPIC_API_KEY', submitted: false };
        const message = { id: 'key-form', botId: 'bot', role: 'assistant' as const, sequence: 1, createdAt: 1, body };

        render(<MessageItem message={message} actions={actions} />);
        fireEvent.click(screen.getByRole('button', { name: 'Use subscription instead' }));
        expect(actions.onChoose)
            .toHaveBeenCalledWith('key-form', 'subscription');
    });
});
