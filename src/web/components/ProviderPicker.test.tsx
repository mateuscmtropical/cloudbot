// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderChoiceSummary } from '../../shared/providerTypes.ts';
import { getBotProvider, listProviders, startProviderConnect, switchBotProvider } from '../apiClient.ts';
import { ProviderPicker } from './ProviderPicker.tsx';

vi.mock('../apiClient.ts', () => ({
    getBotProvider: vi.fn(),
    listProviders: vi.fn(),
    startProviderConnect: vi.fn(),
    switchBotProvider: vi.fn(),
}));

const PROVIDERS: ProviderChoiceSummary[] = [
    { id: 'claude', label: 'Claude', isConnected: true },
    { id: 'gemini', label: 'Gemini', isConnected: true },
    { id: 'chatgpt', label: 'ChatGPT', isConnected: false },
];

describe('ProviderPicker', () => {
    beforeEach(() => {
        vi.mocked(getBotProvider)
            .mockResolvedValue({ provider: 'claude', label: 'Claude', model: 'sonnet' });
        vi.mocked(listProviders)
            .mockResolvedValue(PROVIDERS);
    });

    afterEach(() => {
        cleanup();
        vi.resetAllMocks();
    });

    it('shows the provider and the model of the bot', async () => {
        render(<ProviderPicker botId="bot-1" onOpenSetupChat={() => {}} />);

        expect(await screen.findByText('Claude'))
            .toBeTruthy();
        expect(screen.getByText('sonnet'))
            .toBeTruthy();
    });

    it('shows nothing when the provider cannot be read', async () => {
        vi.mocked(getBotProvider)
            .mockRejectedValue(new Error('offline'));

        const { container } = render(<ProviderPicker botId="bot-1" onOpenSetupChat={() => {}} />);

        await waitFor(() => {
            expect(getBotProvider)
                .toHaveBeenCalled();
        });
        expect(container.querySelector('.provider-picker'))
            .toBeNull();
    });

    it('lists the providers, marks the one in use and offers Connect for the others', async () => {
        render(<ProviderPicker botId="bot-1" onOpenSetupChat={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'AI provider' }));

        const current = await screen.findByRole('menuitemradio', { name: 'Claude' });
        const other = screen.getByRole('menuitemradio', { name: 'Gemini' });

        expect(current.getAttribute('aria-checked'))
            .toBe('true');
        expect(other.getAttribute('aria-checked'))
            .toBe('false');
        expect(screen.getByRole('menuitem', { name: 'Connect ChatGPT' }))
            .toBeTruthy();
    });

    it('switches the bot to the provider the owner picks and closes the menu', async () => {
        vi.mocked(switchBotProvider)
            .mockResolvedValue({ provider: 'gemini', label: 'Gemini', model: null });

        render(<ProviderPicker botId="bot-1" onOpenSetupChat={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'AI provider' }));
        fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Gemini' }));

        await waitFor(() => {
            expect(screen.queryByRole('menu'))
                .toBeNull();
        });
        expect(switchBotProvider)
            .toHaveBeenCalledWith('bot-1', 'gemini');
        expect(screen.getByRole('button', { name: 'AI provider' }).textContent)
            .toBe('Gemini');
    });

    it('opens the setup chat when the owner connects a provider', async () => {
        vi.mocked(startProviderConnect)
            .mockResolvedValue({ botId: 'setup-bot' });
        const onOpenSetupChat = vi.fn();

        render(<ProviderPicker botId="bot-1" onOpenSetupChat={onOpenSetupChat} />);

        fireEvent.click(await screen.findByRole('button', { name: 'AI provider' }));
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Connect ChatGPT' }));

        await waitFor(() => {
            expect(onOpenSetupChat)
                .toHaveBeenCalledWith('setup-bot');
        });
    });

    it('says when the provider could not be changed', async () => {
        vi.mocked(switchBotProvider)
            .mockRejectedValue(new Error('refused'));

        render(<ProviderPicker botId="bot-1" onOpenSetupChat={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'AI provider' }));
        fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Gemini' }));

        expect(await screen.findByText('The provider could not be changed.'))
            .toBeTruthy();
    });

    it('closes the menu with Escape', async () => {
        render(<ProviderPicker botId="bot-1" onOpenSetupChat={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'AI provider' }));
        await screen.findByRole('menu');
        fireEvent.keyDown(document, { key: 'Escape' });

        await waitFor(() => {
            expect(screen.queryByRole('menu'))
                .toBeNull();
        });
    });
});
