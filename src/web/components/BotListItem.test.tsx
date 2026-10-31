// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary } from '../../shared/chatTypes.ts';
import { BotListItem } from './BotListItem.tsx';

const TODAY = new Date();
const ACTIVITY_AT = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate(), 16, 0)
    .getTime();

const BOT: BotSummary = {
    id: 'bot-1',
    name: 'Research',
    title: 'Assistant',
    mascotColor: 'pink',
    mascotShape: 'bubble', mascotEyes: 'smile',
    lastMessagePreview: 'Found three useful sources.',
    hasUnread: true,
    lastMessageSequence: 1,
    lastActivityAt: ACTIVITY_AT,
};

describe('BotListItem', () => {
    afterEach(cleanup);

    it('shows the bot face, name, preview, time, and unread marker', () => {
        render(<BotListItem bot={BOT} isSelected={false} mascotState="idle" onPointerUp={vi.fn()} onClick={vi.fn()} />);

        expect(screen.getByRole('button', { name: /Research.*Found three useful sources/ }))
            .toBeTruthy();
        expect(screen.getByText('16:00'))
            .toBeTruthy();
        expect(screen.getByLabelText('Unread'))
            .toBeTruthy();
    });

    it('forwards row pointer and click events', () => {
        const onPointerUp = vi.fn();
        const onClick = vi.fn();
        const { getByRole } = render(<BotListItem bot={BOT} isSelected={true} mascotState="idle" onPointerUp={onPointerUp} onClick={onClick} />);
        const row = getByRole('button');

        row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        row.click();

        expect(onPointerUp)
            .toHaveBeenCalledTimes(1);
        expect(onClick)
            .toHaveBeenCalledTimes(1);
        expect(row.getAttribute('aria-current'))
            .toBe('true');
    });
});
