// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetGoogleClient, getGoogleClient, saveGoogleClient } from '../apiClient.ts';
import { GoogleSetupForm } from './GoogleSetupForm.tsx';

vi.mock('../apiClient.ts', () => ({
    getGoogleClient: vi.fn(),
    saveGoogleClient: vi.fn(),
    forgetGoogleClient: vi.fn(),
}));

const REDIRECT_URI = 'https://bot.example.com/api/apps/oauth/callback';
const CLIENT_ID = '123456-abc.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-very-secret-value';

describe('GoogleSetupForm', () => {
    beforeEach(() => {
        vi.mocked(getGoogleClient)
            .mockResolvedValue({ configured: false, redirectUri: REDIRECT_URI });
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('lists the manual steps and shows the redirect address to register', async () => {
        render(<GoogleSetupForm botId="bot-1" onSaved={() => {}} onClose={() => {}} />);

        expect(await screen.findByText(REDIRECT_URI))
            .toBeTruthy();
        expect(screen.getByText(/Developer Preview Program/))
            .toBeTruthy();
        expect(screen.getByText(/Use this client for an AI-powered agent/))
            .toBeTruthy();
        expect(screen.getAllByRole('listitem'))
            .toHaveLength(5);
    });

    it('copies the redirect address', async () => {
        const writeText = vi.fn()
            .mockResolvedValue(undefined);

        vi.stubGlobal('navigator', { clipboard: { writeText } });
        render(<GoogleSetupForm botId="bot-1" onSaved={() => {}} onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Copy redirect address' }));

        await waitFor(() => {
            expect(writeText)
                .toHaveBeenCalledWith(REDIRECT_URI);
        });
        expect(await screen.findByText('Copied'))
            .toBeTruthy();
    });

    it('hides the secret field and turns off autocomplete on both fields', async () => {
        render(<GoogleSetupForm botId="bot-1" onSaved={() => {}} onClose={() => {}} />);

        const idField = await screen.findByLabelText('Client ID');
        const secretField = screen.getByLabelText('Client secret');

        expect(secretField.getAttribute('type'))
            .toBe('password');
        expect(idField.getAttribute('autocomplete'))
            .toBe('off');
        expect(secretField.getAttribute('autocomplete'))
            .toBe('off');
    });

    it('saves the client, clears the fields, shows Client saved and tells the panel', async () => {
        const onSaved = vi.fn();

        vi.mocked(saveGoogleClient)
            .mockResolvedValue({ configured: true, redirectUri: REDIRECT_URI });
        const { container } = render(<GoogleSetupForm botId="bot-1" onSaved={onSaved} onClose={() => {}} />);

        fireEvent.change(await screen.findByLabelText('Client ID'), { target: { value: ` ${CLIENT_ID} ` } });
        fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: CLIENT_SECRET } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await screen.findByText(/Client saved/))
            .toBeTruthy();
        expect(saveGoogleClient)
            .toHaveBeenCalledWith('bot-1', CLIENT_ID, CLIENT_SECRET);
        expect(onSaved)
            .toHaveBeenCalledTimes(1);
        expect(screen.queryByLabelText('Client secret'))
            .toBeNull();
        expect(container.textContent)
            .not.toContain(CLIENT_SECRET);
    });

    it('keeps Save off until both fields have text', async () => {
        render(<GoogleSetupForm botId="bot-1" onSaved={() => {}} onClose={() => {}} />);

        const save = await screen.findByRole('button', { name: 'Save' });

        expect((save as HTMLButtonElement).disabled)
            .toBe(true);
        fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: CLIENT_ID } });
        expect((save as HTMLButtonElement).disabled)
            .toBe(true);
        fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: CLIENT_SECRET } });
        expect((save as HTMLButtonElement).disabled)
            .toBe(false);
    });

    it('shows the reason the server gave when it refuses the client', async () => {
        const refusal = Object.assign(new Error('Request failed'), { serverMessage: 'The client ID must end with .apps.googleusercontent.com.' });
        const onSaved = vi.fn();

        vi.mocked(saveGoogleClient)
            .mockRejectedValue(refusal);
        render(<GoogleSetupForm botId="bot-1" onSaved={onSaved} onClose={() => {}} />);

        fireEvent.change(await screen.findByLabelText('Client ID'), { target: { value: 'wrong' } });
        fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: CLIENT_SECRET } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect((await screen.findByRole('alert')).textContent)
            .toBe('The client ID must end with .apps.googleusercontent.com.');
        expect(onSaved)
            .not.toHaveBeenCalled();
    });

    it('shows Client saved for a client that is already there, and forgets it', async () => {
        vi.mocked(getGoogleClient)
            .mockResolvedValue({ configured: true, redirectUri: REDIRECT_URI });
        vi.mocked(forgetGoogleClient)
            .mockResolvedValue(undefined);
        render(<GoogleSetupForm botId="bot-1" onSaved={() => {}} onClose={() => {}} />);

        expect(await screen.findByText(/Client saved/))
            .toBeTruthy();
        expect(screen.queryByLabelText('Client secret'))
            .toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Forget' }));

        expect(await screen.findByLabelText('Client secret'))
            .toBeTruthy();
        expect(forgetGoogleClient)
            .toHaveBeenCalledWith('bot-1');
    });

    it('calls onClose from the close button', async () => {
        const onClose = vi.fn();

        render(<GoogleSetupForm botId="bot-1" onSaved={() => {}} onClose={onClose} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Close Google setup' }));

        expect(onClose)
            .toHaveBeenCalledTimes(1);
    });
});
