// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary } from '../../shared/chatTypes.ts';
import { BotList } from './BotList.tsx';

const BOTS: BotSummary[] = [
    { id: 'bot-a', name: 'Ana', title: 'Assistant', mascotColor: 'blue', mascotShape: 'puff', lastMessagePreview: '', hasUnread: false },
];

describe('BotList new bot button', () => {
    afterEach(() => {
        cleanup();
    });

    it('calls onNewBot when the + button is pressed', () => {
        const onNewBot = vi.fn();
        const { getByLabelText } = render(
            <BotList bots={BOTS} selectedBotId={undefined} selectedMascotState="idle" channels={[]} selectedChannelId={undefined} isOpen={false} onSelectBot={vi.fn()} onSelectChannel={vi.fn()} onNewBot={onNewBot} onConnectApps={vi.fn()} />,
        );

        fireEvent.click(getByLabelText('New bot'));

        expect(onNewBot)
            .toHaveBeenCalledTimes(1);
    });
});
