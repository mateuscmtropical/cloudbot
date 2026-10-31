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
    mascotShape: 'bubble', mascotEyes: 'smile',
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
                onChangeMascot={vi.fn(() => Promise.resolve(undefined))}
                onDeleteBot={vi.fn(() => Promise.resolve(undefined))}
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

    it('turns Edit into Save, saves the name, the color and the shape, then shows Edit again', async () => {
        const onRenameBot = vi.fn(() => Promise.resolve(undefined));
        const onChangeMascot = vi.fn(() => Promise.resolve(undefined));

        render(
            <BotProfilePanel
                bot={BOT}
                onClose={vi.fn()}
                onRenameBot={onRenameBot}
                onChangeMascot={onChangeMascot}
                onDeleteBot={vi.fn(() => Promise.resolve(undefined))}
                onOpenConnectApps={vi.fn()}
                onOpenScreen={vi.fn()}
                pushControls={createPushControls()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

        expect(screen.queryByRole('button', { name: 'Edit' }))
            .toBeNull();

        fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'New name' } });
        fireEvent.click(screen.getByRole('radio', { name: 'mint' }));
        fireEvent.click(screen.getByRole('radio', { name: 'wide' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await screen.findByRole('button', { name: 'Edit' }))
            .toBeTruthy();
        expect(onRenameBot)
            .toHaveBeenCalledWith(BOT.id, 'New name');
        expect(onChangeMascot)
            .toHaveBeenCalledWith(BOT.id, { color: 'mint', shape: 'wide', eyes: 'smile' });
    });

    it('sets the color, the shape and the eyes at once from a ready look, and the eyes alone after', async () => {
        const onChangeMascot = vi.fn(() => Promise.resolve(undefined));

        render(
            <BotProfilePanel
                bot={BOT}
                onClose={vi.fn()}
                onRenameBot={vi.fn(() => Promise.resolve(undefined))}
                onChangeMascot={onChangeMascot}
                onDeleteBot={vi.fn(() => Promise.resolve(undefined))}
                onOpenConnectApps={vi.fn()}
                onOpenScreen={vi.fn()}
                pushControls={createPushControls()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        fireEvent.click(screen.getByRole('radio', { name: 'Hearts' }));
        fireEvent.click(screen.getByRole('radio', { name: 'stars' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await screen.findByRole('button', { name: 'Edit' }))
            .toBeTruthy();
        expect(onChangeMascot)
            .toHaveBeenCalledWith(BOT.id, { color: 'rose', shape: 'puff', eyes: 'stars' });
    });

    it('keeps the form open with the reason when the name is refused, and saves nothing else', async () => {
        const onChangeMascot = vi.fn(() => Promise.resolve(undefined));

        render(
            <BotProfilePanel
                bot={BOT}
                onClose={vi.fn()}
                onRenameBot={vi.fn(() => Promise.resolve('Another bot in a channel has this name.'))}
                onChangeMascot={onChangeMascot}
                onDeleteBot={vi.fn(() => Promise.resolve(undefined))}
                onOpenConnectApps={vi.fn()}
                onOpenScreen={vi.fn()}
                pushControls={createPushControls()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Taken' } });
        fireEvent.click(screen.getByRole('radio', { name: 'mint' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await screen.findByRole('alert'))
            .toHaveProperty('textContent', 'Another bot in a channel has this name.');
        expect(onChangeMascot)
            .not
            .toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Save' }))
            .toBeTruthy();
    });

    it('deletes the bot from the more menu after the owner confirms', async () => {
        const onDeleteBot = vi.fn(() => Promise.resolve(undefined));
        const onClose = vi.fn();

        render(
            <BotProfilePanel
                bot={BOT}
                onClose={onClose}
                onRenameBot={vi.fn(() => Promise.resolve(undefined))}
                onChangeMascot={vi.fn(() => Promise.resolve(undefined))}
                onDeleteBot={onDeleteBot}
                onOpenConnectApps={vi.fn()}
                onOpenScreen={vi.fn()}
                pushControls={createPushControls()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'More options' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete bot' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => {
            expect(onClose)
                .toHaveBeenCalledOnce();
        });
        expect(onDeleteBot)
            .toHaveBeenCalledWith(BOT.id);
    });

    it('uses the device notification setting and shows its help text', async () => {
        render(
            <BotProfilePanel
                bot={BOT}
                onClose={vi.fn()}
                onRenameBot={vi.fn(() => Promise.resolve(undefined))}
                onChangeMascot={vi.fn(() => Promise.resolve(undefined))}
                onDeleteBot={vi.fn(() => Promise.resolve(undefined))}
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
