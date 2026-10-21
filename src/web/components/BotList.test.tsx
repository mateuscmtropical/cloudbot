// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary } from '../../shared/chatTypes.ts';
import { BotList } from './BotList.tsx';

const BOTS: BotSummary[] = [
    { id: 'bot-a', name: 'Ana', title: 'Assistant', mascotColor: 'blue', mascotShape: 'puff', lastMessagePreview: '', hasUnread: false },
    { id: 'bot-b', name: 'Bia', title: 'Assistant', mascotColor: 'pink', mascotShape: 'bubble', lastMessagePreview: '', hasUnread: false },
];

describe('BotList', () => {
    afterEach(() => {
        cleanup();
    });

    it('shows a mascot in each bot, in the bot color and shape', () => {
        const { container } = render(
            <BotList bots={BOTS} selectedBotId={undefined} selectedMascotState="idle" isOpen={false} onSelectBot={vi.fn()} />,
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
            <BotList bots={BOTS} selectedBotId="bot-a" selectedMascotState="thinking" isOpen={false} onSelectBot={vi.fn()} />,
        );
        const selectedFace = container.querySelector('.bot-item.is-selected .cloud-mascot');
        const otherFace = container.querySelector('.bot-item:not(.is-selected) .cloud-mascot');

        expect(selectedFace?.getAttribute('data-state'))
            .toBe('thinking');
        expect(otherFace?.getAttribute('data-state'))
            .toBe('idle');
    });
});
