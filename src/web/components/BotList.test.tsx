// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    });

    it('keeps People and New bot in the header', () => {
        const { container } = render(
            <BotList bots={BOTS} selectedBotId={undefined} selectedMascotState="idle" channels={[]} selectedChannelId={undefined} isOpen={false} onSelectBot={vi.fn()} onSelectChannel={vi.fn()} onNewBot={vi.fn()} onConnectApps={vi.fn()} onPeople={vi.fn()} />,
        );
        const labels = Array.from(container.querySelectorAll('.bot-list-header button'))
            .map(button => button.getAttribute('aria-label'));

        expect(labels)
            .toEqual(['People', 'New bot']);
    });

    it('opens People without a known name and opens Account from the named avatar', () => {
        const props = { bots: BOTS, selectedBotId: undefined, selectedMascotState: 'idle' as const, channels: [], selectedChannelId: undefined, isOpen: false, onSelectBot: vi.fn(), onSelectChannel: vi.fn(), onNewBot: vi.fn(), onConnectApps: vi.fn(), onPeople: vi.fn() };
        const onAccount = vi.fn();
        const { rerender } = render(<BotList {...props} />);

        fireEvent.click(screen.getByRole('button', { name: 'People' }));
        expect(props.onPeople)
            .toHaveBeenCalledTimes(1);

        rerender(<BotList {...props} personName="Maria Regina" onAccount={onAccount} />);
        fireEvent.click(screen.getByRole('button', { name: 'Account' }));

        expect(onAccount)
            .toHaveBeenCalledTimes(1);
        expect(screen.getByText('MR'))
            .toBeTruthy();
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
});
