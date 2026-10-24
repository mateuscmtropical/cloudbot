// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountPanel } from './AccountPanel.tsx';
import type { PushControls } from './AccountPanel.tsx';
import type { PushEnableResult, PushSwitchState } from '../pushClient.ts';

function createPushControls(state: PushSwitchState, turnOnResult: PushEnableResult = 'enabled'): PushControls {
    return {
        readState: vi.fn(() => Promise.resolve(state)),
        turnOn: vi.fn(() => Promise.resolve(turnOnResult)),
        turnOff: vi.fn(() => Promise.resolve()),
    };
}

function readSwitch(): HTMLInputElement {
    return screen.getByRole<HTMLInputElement>('switch', { name: 'Notifications on this device' });
}

describe('AccountPanel', () => {
    afterEach(cleanup);

    it('leads to the password page, the passkeys page and the sign out of the hub', () => {
        render(<AccountPanel onClose={vi.fn()} pushControls={createPushControls('off')} />);

        expect(screen.getByRole('link', { name: 'Change password' })
            .getAttribute('href'))
            .toBe('/__hub/password');
        expect(screen.getByRole('link', { name: 'Manage passkeys' })
            .getAttribute('href'))
            .toBe('/__hub/passkeys');

        const signOutButton = screen.getByRole('button', { name: 'Sign out' });

        expect(signOutButton.closest('form')
            ?.getAttribute('action'))
            .toBe('/__hub/logout');
    });

    it('shows only the notifications on a CloudBot that runs without the hub', () => {
        render(<AccountPanel onClose={vi.fn()} isHub={false} pushControls={createPushControls('off')} />);

        expect(screen.queryByRole('link', { name: 'Change password' }))
            .toBeNull();
        expect(readSwitch())
            .toBeTruthy();
    });

    it('shows the account name, role and People row for a hub owner', () => {
        const onPeople = vi.fn();

        render(
            <AccountPanel
                onClose={vi.fn()}
                onPeople={onPeople}
                personName="Mateus Rocha"
                personRole="Owner"
                pushControls={createPushControls('off')}
            />,
        );

        expect(screen.getByText('MR'))
            .toBeTruthy();
        expect(screen.getByText('Mateus Rocha'))
            .toBeTruthy();
        expect(screen.getByText('Owner'))
            .toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'People' }));

        expect(onPeople)
            .toHaveBeenCalledOnce();
    });

    it('closes from the button', () => {
        const onClose = vi.fn();

        render(<AccountPanel onClose={onClose} pushControls={createPushControls('off')} />);
        fireEvent.click(screen.getByRole('button', { name: 'Close account panel' }));

        expect(onClose)
            .toHaveBeenCalledTimes(1);
    });

    it('turns notifications on from the switch and shows them on', async () => {
        const pushControls = createPushControls('off');

        render(<AccountPanel onClose={vi.fn()} pushControls={pushControls} />);
        await waitFor(() => {
            expect(readSwitch().disabled)
                .toBe(false);
        });
        fireEvent.click(readSwitch());

        expect(pushControls.turnOn)
            .toHaveBeenCalledTimes(1);
        await waitFor(() => {
            expect(readSwitch().checked)
                .toBe(true);
        });
    });

    it('turns notifications off when they are on', async () => {
        const pushControls = createPushControls('on');

        render(<AccountPanel onClose={vi.fn()} pushControls={pushControls} />);
        await waitFor(() => {
            expect(readSwitch().checked)
                .toBe(true);
        });
        fireEvent.click(readSwitch());

        await waitFor(() => {
            expect(readSwitch().checked)
                .toBe(false);
        });
        expect(pushControls.turnOff)
            .toHaveBeenCalledTimes(1);
    });

    it('says how to allow notifications when the browser blocked them, and keeps the switch off', async () => {
        const pushControls = createPushControls('off', 'blocked');

        render(<AccountPanel onClose={vi.fn()} pushControls={pushControls} />);
        await waitFor(() => {
            expect(readSwitch().disabled)
                .toBe(false);
        });
        fireEvent.click(readSwitch());

        await screen.findByText(/Notifications are blocked for this site/);
        expect(readSwitch().checked)
            .toBe(false);
        expect(readSwitch().disabled)
            .toBe(true);
    });
});
