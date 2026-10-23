// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
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

    it('orders the header buttons People, Search bots, New bot', () => {
        const { container } = render(
            <BotList bots={BOTS} selectedBotId={undefined} selectedMascotState="idle" channels={[]} selectedChannelId={undefined} isOpen={false} onSelectBot={vi.fn()} onSelectChannel={vi.fn()} onNewBot={vi.fn()} onConnectApps={vi.fn()} onPeople={vi.fn()} />,
        );
        const labels = Array.from(container.querySelectorAll('.bot-list-header button'))
            .map(button => button.getAttribute('aria-label'));

        expect(labels)
            .toEqual(['People', 'Search bots', 'New bot']);
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
