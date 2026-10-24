// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type { PushControls } from './AccountPanel.tsx';
import type { PushEnableResult, PushSwitchState } from '../pushClient.ts';
import { BotProfilePanel } from './BotProfilePanel.tsx';

const BOT: BotSummary = {
    id: 'bot-1',
    name: 'Outbound Prospecting',
    title: 'Assistant',
    mascotColor: 'pink',
    mascotShape: 'bubble',
    lastMessagePreview: '',
    hasUnread: false,
    lastMessageSequence: 0,
};

function createPushControls(): PushControls {
    return {
        readState: vi.fn(() => Promise.resolve<PushSwitchState>('off')),
        turnOn: vi.fn(() => Promise.resolve<PushEnableResult>('enabled')),
        turnOff: vi.fn(() => Promise.resolve()),
    };
}

afterEach(cleanup);

describe('BotProfilePanel', () => {
    it('shows the bot profile and opens each available destination', () => {
        const onOpenConnectApps = vi.fn();
        const onOpenScreen = vi.fn();

        render(
            <BotProfilePanel
                bot={BOT}
                onClose={vi.fn()}
                onRenameBot={vi.fn(() => Promise.resolve(undefined))}
                onOpenConnectApps={onOpenConnectApps}
                onOpenScreen={onOpenScreen}
                computerState="Idle"
                pushControls={createPushControls()}
            />,
        );

        expect(screen.getByRole('heading', { name: BOT.name }))
            .toBeTruthy();
        expect(screen.getByText('Idle'))
            .toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Connected apps' }));
        fireEvent.click(screen.getByRole('button', { name: 'Computer Idle' }));

        expect(onOpenConnectApps)
            .toHaveBeenCalledOnce();
        expect(onOpenScreen)
            .toHaveBeenCalledOnce();
    });

    it('renames the bot through the existing rename handler', async () => {
        const onRenameBot = vi.fn(() => Promise.resolve(undefined));

        render(
            <BotProfilePanel
                bot={BOT}
                onClose={vi.fn()}
                onRenameBot={onRenameBot}
                onOpenConnectApps={vi.fn()}
                onOpenScreen={vi.fn()}
                pushControls={createPushControls()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        const nameField = screen.getByRole<HTMLInputElement>('textbox', { name: `Name of ${BOT.name}` });

        fireEvent.change(nameField, { target: { value: 'New name' } });
        fireEvent.keyDown(nameField, { key: 'Enter' });

        await waitFor(() => {
            expect(onRenameBot)
                .toHaveBeenCalledWith(BOT.id, 'New name');
        });
    });

    it('uses the device notification setting and shows its help text', async () => {
        render(
            <BotProfilePanel
                bot={BOT}
                onClose={vi.fn()}
                onRenameBot={vi.fn(() => Promise.resolve(undefined))}
                onOpenConnectApps={vi.fn()}
                onOpenScreen={vi.fn()}
                pushControls={createPushControls()}
            />,
        );

        expect(await screen.findByText(/Get a notification on this device/))
            .toBeTruthy();
        expect(screen.getByRole('switch', { name: 'Notifications on this device' }))
            .toBeTruthy();
    });
});
