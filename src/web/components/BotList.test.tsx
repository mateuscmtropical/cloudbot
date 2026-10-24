// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type { ChannelSummary } from '../../shared/channelTypes.ts';
import { BotList } from './BotList.tsx';

const BOTS: BotSummary[] = [
    { id: 'bot-a', name: 'Ana', title: 'Assistant', mascotColor: 'blue', mascotShape: 'puff', lastMessagePreview: '', hasUnread: false, lastMessageSequence: 0 },
    { id: 'bot-b', name: 'Bia', title: 'Assistant', mascotColor: 'pink', mascotShape: 'bubble', lastMessagePreview: '', hasUnread: false, lastMessageSequence: 0 },
];

describe('BotList', () => {
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('keeps the People, search, and New bot buttons in the header', () => {
        const { container } = render(
            <BotList bots={BOTS} selectedBotId={undefined} selectedMascotState="idle" channels={[]} selectedChannelId={undefined} isOpen={false} onSelectBot={vi.fn()} onSelectChannel={vi.fn()} onNewBot={vi.fn()} onConnectApps={vi.fn()} onPeople={vi.fn()} />,
        );
        const labels = Array.from(container.querySelectorAll('.bot-list-header button'))
            .map(button => button.getAttribute('aria-label'));

        expect(labels)
            .toEqual(['People', 'Focus search', 'New bot']);
    });

    it('keeps Account and People reachable on standalone and hub lists', () => {
        const props = { bots: BOTS, selectedBotId: undefined, selectedMascotState: 'idle' as const, channels: [], selectedChannelId: undefined, isOpen: false, onSelectBot: vi.fn(), onSelectChannel: vi.fn(), onNewBot: vi.fn(), onConnectApps: vi.fn(), onPeople: vi.fn() };
        const onAccount = vi.fn();
        const { container, rerender } = render(<BotList {...props} onAccount={onAccount} />);

        expect(screen.getByText('CB'))
            .toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'People' }));
        expect(props.onPeople)
            .toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Account' }));
        expect(onAccount)
            .toHaveBeenCalledTimes(1);

        rerender(<BotList {...props} personName="Maria Regina" onAccount={onAccount} />);
        expect(container.querySelector('.bot-list-header .round-button-avatar')?.textContent)
            .toBe('MR');
        expect(screen.getByRole('button', { name: 'People' }))
            .toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Account' }));

        expect(onAccount)
            .toHaveBeenCalledTimes(2);
    });

    it('focuses the bottom search pill from the header search button', () => {
        render(
            <BotList bots={BOTS} selectedBotId={undefined} selectedMascotState="idle" channels={[]} selectedChannelId={undefined} isOpen={false} onSelectBot={vi.fn()} onSelectChannel={vi.fn()} onNewBot={vi.fn()} onConnectApps={vi.fn()} onPeople={vi.fn()} onAccount={vi.fn()} />,
        );

        const searchInput = screen.getByRole('searchbox', { name: 'Search bots' });

        fireEvent.click(screen.getByRole('button', { name: 'Focus search' }));

        expect(document.activeElement)
            .toBe(searchInput);
    });

    it('filters bots by name from the controlled search field', () => {
        render(
            <BotList bots={BOTS} selectedBotId={undefined} selectedMascotState="idle" channels={[]} selectedChannelId={undefined} isOpen={false} onSelectBot={vi.fn()} onSelectChannel={vi.fn()} onNewBot={vi.fn()} onConnectApps={vi.fn()} onPeople={vi.fn()} />,
        );

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search bots' }), { target: { value: 'bia' } });

        expect(screen.getByText('Bia'))
            .toBeTruthy();
        expect(screen.queryByText('Ana'))
            .toBeNull();
    });

    it('shows a mascot in each bot, in the bot color and shape', () => {
        const { container } = render(
            <BotList bots={BOTS} selectedBotId={undefined} selectedMascotState="idle" channels={[]} selectedChannelId={undefined} isOpen={false} onSelectBot={vi.fn()} onSelectChannel={vi.fn()} onNewBot={vi.fn()} onConnectApps={vi.fn()} onPeople={vi.fn()} />,
        );
        const mascots = container.querySelectorAll('.bot-item .cloud-mascot');

        expect(mascots)
            .toHaveLength(2);
        expect(mascots[1]?.getAttribute('data-shape'))
            .toBe('bubble');
        expect(container.querySelector('.bot-item .avatar'))
            .toBeNull();
    });

    it('shows the live face on the selected bot and the idle face on the others', () => {
        const { container } = render(
            <BotList bots={BOTS} selectedBotId="bot-a" selectedMascotState="thinking" channels={[]} selectedChannelId={undefined} isOpen={false} onSelectBot={vi.fn()} onSelectChannel={vi.fn()} onNewBot={vi.fn()} onConnectApps={vi.fn()} onPeople={vi.fn()} />,
        );
        const selectedFace = container.querySelector('.bot-item.is-selected .cloud-mascot');
        const otherFace = container.querySelector('.bot-item:not(.is-selected) .cloud-mascot');

        expect(selectedFace?.getAttribute('data-state'))
            .toBe('thinking');
        expect(otherFace?.getAttribute('data-state'))
            .toBe('idle');
    });

    it('lists each channel with its roster, and opens it when pressed', () => {
        const onSelectChannel = vi.fn();
        const channels: ChannelSummary[] = [
            {
                id: 'channel-1',
                name: 'Project',
                members: [
                    { botId: 'bot-a', name: 'Ana', mascotColor: 'blue', mascotShape: 'puff', isManager: true },
                    { botId: 'bot-b', name: 'Bia', mascotColor: 'pink', mascotShape: 'bubble', isManager: false },
                ],
            },
        ];
        const { container, getByText } = render(
            <BotList bots={BOTS} selectedBotId={undefined} selectedMascotState="idle" channels={channels} selectedChannelId={undefined} isOpen={false} onSelectBot={vi.fn()} onSelectChannel={onSelectChannel} onNewBot={vi.fn()} onConnectApps={vi.fn()} onPeople={vi.fn()} />,
        );

        expect(getByText('Ana (manager), Bia'))
            .toBeDefined();
        expect(container.querySelector('.channel-section-title'))
            .not.toBeNull();

        fireEvent.click(getByText('Project'));

        expect(onSelectChannel)
            .toHaveBeenCalledWith('channel-1');
    });

    it('opens a bot menu on right click without adding actions to channels', () => {
        const onSelectBot = vi.fn();
        const channels: ChannelSummary[] = [{ id: 'channel-1', name: 'Project', members: [] }];

        render(
            <BotList
                bots={BOTS}
                selectedBotId={undefined}
                selectedMascotState="idle"
                channels={channels}
                selectedChannelId={undefined}
                isOpen={false}
                onSelectBot={onSelectBot}
                onSelectChannel={vi.fn()}
                onNewBot={vi.fn()}
                onConnectApps={vi.fn()}
                onPeople={vi.fn()}
                onRenameBot={vi.fn(() => Promise.resolve(undefined))}
                onDeleteBot={vi.fn(() => Promise.resolve(undefined))}
            />,
        );

        const anaRow = screen.getByRole('button', { name: 'Ana' });

        fireEvent.contextMenu(anaRow);

        expect(screen.getByRole('dialog', { name: 'Actions for Ana' }))
            .toBeTruthy();
        expect(screen.queryByRole('button', { name: 'More options for Project' }))
            .toBeNull();
        expect(onSelectBot)
            .not.toHaveBeenCalled();
    });

    it('opens the bot menu after a touch hold, suppresses selection, and shows a delete refusal', async () => {
        vi.useFakeTimers();
        const onSelectBot = vi.fn();
        const onDeleteBot = vi.fn(() => Promise.resolve('The last bot cannot be deleted.'));

        render(
            <BotList
                bots={BOTS}
                selectedBotId={undefined}
                selectedMascotState="idle"
                channels={[]}
                selectedChannelId={undefined}
                isOpen={false}
                onSelectBot={onSelectBot}
                onSelectChannel={vi.fn()}
                onNewBot={vi.fn()}
                onConnectApps={vi.fn()}
                onPeople={vi.fn()}
                onRenameBot={vi.fn(() => Promise.resolve(undefined))}
                onDeleteBot={onDeleteBot}
            />,
        );

        const anaRow = screen.getByRole('button', { name: 'Ana' });

        fireEvent.pointerDown(anaRow, { pointerType: 'touch', pointerId: 1, button: 0, clientX: 20, clientY: 20 });
        act(() => {
            vi.advanceTimersByTime(450);
        });
        fireEvent.pointerUp(anaRow, { pointerType: 'touch', pointerId: 1, button: 0, clientX: 20, clientY: 20 });
        fireEvent.click(anaRow);

        expect(screen.getByRole('dialog', { name: 'Actions for Ana' }))
            .toBeTruthy();
        expect(onSelectBot)
            .not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        expect(screen.getByRole('alertdialog', { name: 'Delete Ana?' }).textContent)
            .toContain('chats, rules, routines, webhooks, secrets, and files');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
            await Promise.resolve();
        });

        expect(onDeleteBot)
            .toHaveBeenCalledWith('bot-a');
        const alertText = screen.getByRole('alert').textContent;

        expect(alertText)
            .toContain('The last bot cannot be deleted.');
    });
});
