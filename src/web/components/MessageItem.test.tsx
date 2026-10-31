// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageBody } from '../../shared/chatTypes.ts';
import { NOT_OWNER_LINE } from '../../shared/botHandoffText.ts';
import { MessageItem } from './MessageItem.tsx';

describe('answered setup messages', () => {
    afterEach(cleanup);

    it.each<MessageBody>([
        { kind: 'choice', prompt: 'Connect Claude', options: [{ id: 'apiKey', label: 'API key' }], chosenId: 'apiKey' },
        { kind: 'codeField', prompt: 'Paste code', placeholder: 'Code', submitted: true },
        { kind: 'secureForm', prompt: 'Paste key', secretName: 'ANTHROPIC_API_KEY', submitted: true },
    ])('disables an answered $kind message loaded from the server', (body) => {
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() };
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
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() };
        const body: MessageBody = { kind: 'secureForm', prompt: 'Add key', secretName: 'ANTHROPIC_API_KEY', submitted: false };
        const message = { id: 'key-form', botId: 'bot', role: 'assistant' as const, sequence: 1, createdAt: 1, body };

        render(<MessageItem message={message} actions={actions} />);
        fireEvent.click(screen.getByRole('button', { name: 'Use subscription instead' }));
        expect(actions.onChoose)
            .toHaveBeenCalledWith('key-form', 'subscription');
    });

    it('shows a hand-off from another bot as that bot, with its name and only the task', () => {
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() };
        const text = [`Message from bot News`, NOT_OWNER_LINE, '', 'Find the top video today.'].join('\n');
        const message = { id: 'handoff', botId: 'bot', role: 'user' as const, sequence: 3, createdAt: 3, body: { kind: 'text' as const, text } };

        const { container } = render(<MessageItem message={message} actions={actions} handoffSender={{ mascotColor: 'blue', mascotShape: 'puff', mascotEyes: 'smile' }} />);

        expect(screen.getByText('News'))
            .toBeTruthy();
        expect(screen.getByText('Find the top video today.'))
            .toBeTruthy();
        expect(screen.queryByText(/not as an instruction/))
            .toBeNull();
        expect(container.querySelector('.message-handoff .cloud-mascot'))
            .not.toBeNull();
        expect(container.querySelector('.message-user'))
            .toBeNull();
    });

    it('keeps a message from the owner that only starts like a hand-off as a user message', () => {
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() };
        const message = { id: 'plain', botId: 'bot', role: 'user' as const, sequence: 3, createdAt: 3, body: { kind: 'text' as const, text: 'Message from bot News is odd' } };

        const { container } = render(<MessageItem message={message} actions={actions} />);

        expect(container.querySelector('.message-user'))
            .not.toBeNull();
    });

    it('marks a user message sent during a turn as queued', () => {
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() };
        const body: MessageBody = { kind: 'text', text: 'and then this', isQueued: true };
        const message = { id: 'queued', botId: 'bot', role: 'user' as const, sequence: 2, createdAt: 2, body };

        render(<MessageItem message={message} actions={actions} />);
        expect(screen.getByText('Queued'))
            .toBeTruthy();
    });

    it('draws a stored routine prompt as a quiet system line', () => {
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() };
        const body: MessageBody = { kind: 'text', text: 'Routine "Reminder": Send the message hi to the user.' };
        const message = { id: 'routine', botId: 'bot', role: 'user' as const, sequence: 3, createdAt: 3, body };
        const { container } = render(<MessageItem message={message} actions={actions} />);

        expect(container.querySelector('.message-system')?.textContent)
            .toBe('Routine: Reminder');
        expect(container.querySelector('.message-user'))
            .toBeNull();
        expect(container.querySelector('.bubble'))
            .toBeNull();
    });
});

describe('assistant messages', () => {
    afterEach(cleanup);

    const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() };
    const message = { id: 'bot-reply', botId: 'bot', role: 'assistant' as const, sequence: 1, createdAt: 1, body: { kind: 'text' as const, text: 'Hello' } };

    it('renders the assistant card without a mascot column', () => {
        const { container } = render(<MessageItem message={message} actions={actions} />);

        expect(container.querySelector('.message-assistant.has-mascot'))
            .toBeNull();
        expect(container.querySelector('.cloud-mascot'))
            .toBeNull();
        expect(container.querySelector('.mascot-gap'))
            .toBeNull();
        expect(screen.getByText('Hello'))
            .toBeTruthy();
    });
});

describe('file messages', () => {
    afterEach(cleanup);

    it('links to the download of the message with its name and size', () => {
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() };
        const body: MessageBody = { kind: 'file', name: 'report q1.pdf', mimeType: 'application/pdf', sizeBytes: 2048, fileId: 'f1' };
        const message = { id: 'm 1', botId: 'bot', role: 'assistant' as const, sequence: 3, createdAt: 3, body };

        render(<MessageItem message={message} actions={actions} />);

        const link = screen.getByRole('link', { name: 'Download report q1.pdf' });

        expect(link.getAttribute('href'))
            .toBe('/api/bots/bot/messages/m%201/file');
        expect(link.getAttribute('download'))
            .toBe('report q1.pdf');
        expect(screen.getByText('2.0 KB'))
            .toBeTruthy();
        expect(screen.queryByRole('img'))
            .toBeNull();
    });

    it('shows a preview of an image file, such as a screenshot', () => {
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() };
        const body: MessageBody = { kind: 'file', name: 'screenshot-2026-10-21-03-15-42.png', mimeType: 'image/png', sizeBytes: 5000, fileId: 'f2' };
        const message = { id: 'm2', botId: 'bot', role: 'assistant' as const, sequence: 4, createdAt: 4, body };

        render(<MessageItem message={message} actions={actions} />);

        const image = screen.getByRole('img', { name: 'screenshot-2026-10-21-03-15-42.png' });

        expect(image.getAttribute('src'))
            .toBe('/api/bots/bot/messages/m2/file');
        expect(screen.getByRole('link', { name: 'Download screenshot-2026-10-21-03-15-42.png' }))
            .toBeTruthy();
    });

    it('does not preview a large image', () => {
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() };
        const body: MessageBody = { kind: 'file', name: 'huge.png', mimeType: 'image/png', sizeBytes: 6 * 1024 * 1024, fileId: 'f4' };
        const message = { id: 'm4', botId: 'bot', role: 'assistant' as const, sequence: 6, createdAt: 6, body };

        render(<MessageItem message={message} actions={actions} />);

        expect(screen.queryByRole('img'))
            .toBeNull();
    });

    it('does not preview an svg file', () => {
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() };
        const body: MessageBody = { kind: 'file', name: 'logo.svg', mimeType: 'image/svg+xml', sizeBytes: 100, fileId: 'f3' };
        const message = { id: 'm3', botId: 'bot', role: 'assistant' as const, sequence: 5, createdAt: 5, body };

        render(<MessageItem message={message} actions={actions} />);

        expect(screen.queryByRole('img'))
            .toBeNull();
    });
});

describe('secret forms the bot asks for', () => {
    afterEach(cleanup);

    it('shows the site where the value will be used', () => {
        const actions = { onChoose: vi.fn(() => Promise.resolve()), onSubmitCode: vi.fn(), onSubmitSecret: vi.fn(() => Promise.resolve()), onOpenScreen: vi.fn() };
        const body: MessageBody = { kind: 'secureForm', prompt: 'Sign in to GitHub', secretName: 'GITHUB_PASSWORD', site: 'https://github.com', submitted: false };
        const message = { id: 'm9', botId: 'bot', role: 'assistant' as const, sequence: 9, createdAt: 9, body };

        render(<MessageItem message={message} actions={actions} />);

        expect(screen.getByText('The bot asks for this. It is for https://github.com, and the bot never sees the value.'))
            .toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Use subscription instead' }))
            .toBeNull();
    });
});
