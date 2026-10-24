// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetBitwardenAccount, getBitwardenStatus, saveBitwardenAccount, testBitwardenAccount } from '../apiClient.ts';
import { BitwardenSetupForm } from './BitwardenSetupForm.tsx';

vi.mock('../apiClient.ts', () => ({
    getBitwardenStatus: vi.fn(),
    saveBitwardenAccount: vi.fn(),
    forgetBitwardenAccount: vi.fn(),
    testBitwardenAccount: vi.fn(),
}));

const CLIENT_ID = 'user.11111111-2222-3333-4444-555555555555';
const CLIENT_SECRET = 'fakeclientsecret0123456789';
const MASTER_PASSWORD = 'fake master password';
const DEFAULT_SERVER = 'https://vault.bitwarden.com';

function fillFields(): void {
    fireEvent.change(screen.getByLabelText('API client ID'), { target: { value: ` ${CLIENT_ID} ` } });
    fireEvent.change(screen.getByLabelText('API client secret'), { target: { value: ` ${CLIENT_SECRET} ` } });
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: MASTER_PASSWORD } });
}

describe('BitwardenSetupForm', () => {
    beforeEach(() => {
        vi.mocked(getBitwardenStatus)
            .mockResolvedValue({ configured: false, serverUrl: '' });
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it('recommends a separate account and says the master password stays in the CloudBot vault', async () => {
        render(<BitwardenSetupForm botId="bot-1" onClose={() => {}} />);

        expect(await screen.findByLabelText('API client ID'))
            .toBeTruthy();
        expect(screen.getByText(/separate Bitwarden account, or an organization collection/))
            .toBeTruthy();
        expect(screen.getByText(/CloudBot keeps all three in its own vault, away from the bot/))
            .toBeTruthy();
        expect(screen.getByText(/Settings, Security, Keys/))
            .toBeTruthy();
    });

    it('starts on the Bitwarden cloud address and lets the owner change it', async () => {
        render(<BitwardenSetupForm botId="bot-1" onClose={() => {}} />);

        const serverField = await screen.findByLabelText('Server address');

        expect((serverField as HTMLInputElement).value)
            .toBe(DEFAULT_SERVER);

        fireEvent.change(serverField, { target: { value: 'https://vault.bitwarden.eu' } });
        fillFields();
        vi.mocked(saveBitwardenAccount)
            .mockResolvedValue({ configured: true, serverUrl: 'https://vault.bitwarden.eu' });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await screen.findByText('Saved for https://vault.bitwarden.eu.'))
            .toBeTruthy();
        expect(saveBitwardenAccount)
            .toHaveBeenCalledWith('bot-1', { serverUrl: 'https://vault.bitwarden.eu', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, masterPassword: MASTER_PASSWORD });
    });

    it('hides both secrets and turns off autocomplete on every field', async () => {
        render(<BitwardenSetupForm botId="bot-1" onClose={() => {}} />);

        const secretField = await screen.findByLabelText('API client secret');
        const passwordField = screen.getByLabelText('Master password');

        expect(secretField.getAttribute('type'))
            .toBe('password');
        expect(passwordField.getAttribute('type'))
            .toBe('password');
        ['Server address', 'API client ID', 'API client secret', 'Master password'].forEach((label) => {
            expect(screen.getByLabelText(label)
                .getAttribute('autocomplete'))
                .toBe('off');
        });
    });

    it('keeps Save off until the API key and the master password are filled', async () => {
        render(<BitwardenSetupForm botId="bot-1" onClose={() => {}} />);

        const save = await screen.findByRole('button', { name: 'Save' });

        expect((save as HTMLButtonElement).disabled)
            .toBe(true);
        fireEvent.change(screen.getByLabelText('API client ID'), { target: { value: CLIENT_ID } });
        fireEvent.change(screen.getByLabelText('API client secret'), { target: { value: CLIENT_SECRET } });
        expect((save as HTMLButtonElement).disabled)
            .toBe(true);
        fireEvent.change(screen.getByLabelText('Master password'), { target: { value: MASTER_PASSWORD } });
        expect((save as HTMLButtonElement).disabled)
            .toBe(false);
    });

    it('saves, clears every secret from the page and offers Test connection and Forget', async () => {
        vi.mocked(saveBitwardenAccount)
            .mockResolvedValue({ configured: true, serverUrl: DEFAULT_SERVER });

        const { container } = render(<BitwardenSetupForm botId="bot-1" onClose={() => {}} />);

        await screen.findByLabelText('API client ID');
        fillFields();
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await screen.findByText(`Saved for ${DEFAULT_SERVER}.`))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Test connection' }))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Forget' }))
            .toBeTruthy();
        expect(screen.queryByLabelText('Master password'))
            .toBeNull();
        expect(container.textContent).not.toContain(CLIENT_SECRET);
        expect(container.textContent).not.toContain(MASTER_PASSWORD);
        expect(container.querySelector('input'))
            .toBeNull();
    });

    it('shows the reason the server gave when it refuses a field', async () => {
        const refusal = Object.assign(new Error('Request failed'), { serverMessage: 'The client ID looks like user. followed by an id with dashes. Copy it from the API key in Bitwarden.' });

        vi.mocked(saveBitwardenAccount)
            .mockRejectedValue(refusal);
        render(<BitwardenSetupForm botId="bot-1" onClose={() => {}} />);

        await screen.findByLabelText('API client ID');
        fillFields();
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect((await screen.findByRole('alert')).textContent)
            .toContain('The client ID looks like user.');
    });

    it('shows Saved for an account that is already there, tests it and says only ok', async () => {
        vi.mocked(getBitwardenStatus)
            .mockResolvedValue({ configured: true, serverUrl: DEFAULT_SERVER });
        vi.mocked(testBitwardenAccount)
            .mockResolvedValue({ ok: true });
        render(<BitwardenSetupForm botId="bot-1" onClose={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));

        expect(await screen.findByText('Connection ok.'))
            .toBeTruthy();
        expect(testBitwardenAccount)
            .toHaveBeenCalledWith('bot-1');
        expect(screen.queryByRole('alert'))
            .toBeNull();
    });

    it('shows the error of a failed test', async () => {
        vi.mocked(getBitwardenStatus)
            .mockResolvedValue({ configured: true, serverUrl: DEFAULT_SERVER });
        vi.mocked(testBitwardenAccount)
            .mockResolvedValue({ ok: false, error: 'Bitwarden did not unlock. Check the master password.' });
        render(<BitwardenSetupForm botId="bot-1" onClose={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));

        expect((await screen.findByRole('alert')).textContent)
            .toBe('Bitwarden did not unlock. Check the master password.');
        expect(screen.queryByText('Connection ok.'))
            .toBeNull();
    });

    it('says when the test could not run at all', async () => {
        vi.mocked(getBitwardenStatus)
            .mockResolvedValue({ configured: true, serverUrl: DEFAULT_SERVER });
        vi.mocked(testBitwardenAccount)
            .mockRejectedValue(new Error('network'));
        render(<BitwardenSetupForm botId="bot-1" onClose={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));

        expect((await screen.findByRole('alert')).textContent)
            .toBe('The connection test could not run. Try again.');
    });

    it('forgets the account and shows the empty form again', async () => {
        vi.mocked(getBitwardenStatus)
            .mockResolvedValue({ configured: true, serverUrl: DEFAULT_SERVER });
        vi.mocked(forgetBitwardenAccount)
            .mockResolvedValue(undefined);
        render(<BitwardenSetupForm botId="bot-1" onClose={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Forget' }));

        expect(await screen.findByLabelText('Master password'))
            .toBeTruthy();
        expect(forgetBitwardenAccount)
            .toHaveBeenCalledWith('bot-1');
    });

    it('calls onClose from the close button', async () => {
        const onClose = vi.fn();

        render(<BitwardenSetupForm botId="bot-1" onClose={onClose} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Close Bitwarden setup' }));

        expect(onClose)
            .toHaveBeenCalledTimes(1);
    });
});
