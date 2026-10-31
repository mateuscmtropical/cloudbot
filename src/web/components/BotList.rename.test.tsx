// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary } from '../../shared/chatTypes.ts';
import { BotList } from './BotList.tsx';

const BOTS: BotSummary[] = [
    { id: 'bot-a', name: 'Ana', title: 'Assistant', mascotColor: 'blue', mascotShape: 'puff', mascotEyes: 'smile', lastMessagePreview: 'Hello', hasUnread: false, lastMessageSequence: 0 },
    { id: 'bot-b', name: 'Bia', title: 'Assistant', mascotColor: 'pink', mascotShape: 'bubble', mascotEyes: 'smile', lastMessagePreview: '', hasUnread: false, lastMessageSequence: 0 },
];

function renderList(onRenameBot?: (botId: string, name: string) => Promise<string | undefined>): void {
    render(
        <BotList
            bots={BOTS}
            selectedBotId="bot-a"
            selectedMascotState="idle"
            channels={[]}
            selectedChannelId={undefined}
            isOpen={false}
            onSelectBot={vi.fn()}
            onSelectChannel={vi.fn()}
            onNewBot={vi.fn()}
            onConnectApps={vi.fn()}
            onPeople={vi.fn()}
            onRenameBot={onRenameBot}
        />,
    );
}

function tapRow(name: string): void {
    const row = screen.getByText(name)
        .closest('button');

    if (row === null) {
        throw new Error(`No row for ${name}`);
    }

    fireEvent.pointerUp(row);
}

describe('BotList rename', () => {
    afterEach(() => {
        cleanup();
    });

    it('turns the name into a field after a double tap on the row', () => {
        renderList(() => Promise.resolve(undefined));

        tapRow('Ana');

        expect(screen.queryByRole('textbox'))
            .toBeNull();

        tapRow('Ana');

        expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name of Ana' }).value)
            .toBe('Ana');
    });

    it('does not count one tap on each of two rows as a double tap', () => {
        renderList(() => Promise.resolve(undefined));

        tapRow('Ana');
        tapRow('Bia');

        expect(screen.queryByRole('textbox'))
            .toBeNull();
    });

    it('saves the new name through onRenameBot and goes back to the row', async () => {
        const onRenameBot = vi.fn(() => Promise.resolve(undefined));

        renderList(onRenameBot);
        tapRow('Ana');
        tapRow('Ana');

        const input = screen.getByRole('textbox', { name: 'Name of Ana' });

        fireEvent.change(input, { target: { value: 'Maria' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await vi.waitFor(() => {
            expect(screen.queryByRole('textbox'))
                .toBeNull();
        });
        expect(onRenameBot)
            .toHaveBeenCalledWith('bot-a', 'Maria');
    });

    it('does nothing on a double tap when rows cannot be renamed', () => {
        renderList(undefined);

        tapRow('Ana');
        tapRow('Ana');

        expect(screen.queryByRole('textbox'))
            .toBeNull();
    });
});
