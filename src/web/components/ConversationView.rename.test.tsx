// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary } from '../../shared/chatTypes.ts';
import { ConversationView } from './ConversationView.tsx';

const BOT: BotSummary = { id: 'bot-a', name: 'Ana', title: 'Assistant', mascotColor: 'blue', mascotShape: 'puff', mascotEyes: 'smile', lastMessagePreview: '', hasUnread: false, lastMessageSequence: 0 };

const NOOP_ACTIONS = {
    onChoose: vi.fn(() => Promise.resolve()),
    onSubmitCode: vi.fn(),
    onSubmitSecret: vi.fn(() => Promise.resolve()),
    onOpenScreen: vi.fn(),
};

function renderConversation(onRenameBot?: (botId: string, name: string) => Promise<string | undefined>): ReturnType<typeof render> {
    return render(
        <ConversationView
            bot={BOT}
            messages={[]}
            draftText=""
            isRunning={false}
            attachments={[]}
            isUploading={false}
            onRemoveAttachment={vi.fn()}
            actions={NOOP_ACTIONS}
            onOpenBotList={vi.fn()}
            onSend={vi.fn()}
            onStop={vi.fn()}
            onAttach={vi.fn()}
            onRenameBot={onRenameBot}
        />,
    );
}

function tapName(): void {
    fireEvent.pointerUp(screen.getByText('Ana'));
}

function tapMascot(container: HTMLElement): void {
    const mascot = container.querySelector('.bot-pill .cloud-mascot');

    if (mascot === null) {
        throw new Error('The bot mascot is missing');
    }

    fireEvent.pointerUp(mascot);
}

describe('ConversationView rename', () => {
    afterEach(() => {
        cleanup();
    });

    it('turns the name in the header into a field after a double tap', () => {
        renderConversation(() => Promise.resolve(undefined));

        tapName();

        expect(screen.queryByRole('textbox', { name: 'Name of Ana' }))
            .toBeNull();

        tapName();

        expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name of Ana' }).value)
            .toBe('Ana');
    });

    it('saves through onRenameBot and shows the name again', async () => {
        const onRenameBot = vi.fn(() => Promise.resolve(undefined));

        renderConversation(onRenameBot);
        tapName();
        tapName();

        const input = screen.getByRole('textbox', { name: 'Name of Ana' });

        fireEvent.change(input, { target: { value: 'Maria' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(screen.queryByRole('textbox', { name: 'Name of Ana' }))
                .toBeNull();
        });
        expect(onRenameBot)
            .toHaveBeenCalledWith('bot-a', 'Maria');
    });

    it('does nothing on a double tap when the name cannot be changed here', () => {
        renderConversation(undefined);

        tapName();
        tapName();

        expect(screen.queryByRole('textbox', { name: 'Name of Ana' }))
            .toBeNull();
    });

    it('does not rename when the mascot is double tapped', () => {
        const view = renderConversation(() => Promise.resolve(undefined));

        tapMascot(view.container);
        tapMascot(view.container);

        expect(screen.queryByRole('textbox', { name: 'Name of Ana' }))
            .toBeNull();
    });
});
