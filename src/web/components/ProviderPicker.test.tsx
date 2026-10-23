// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotProviderSummary, ProviderChoiceSummary } from '../../shared/providerTypes.ts';
import { getBotProvider, listProviders, saveProviderModel, startProviderConnect, switchBotProvider } from '../apiClient.ts';
import { ProviderPicker } from './ProviderPicker.tsx';

vi.mock('../apiClient.ts', () => ({
    getBotProvider: vi.fn(),
    listProviders: vi.fn(),
    startProviderConnect: vi.fn(),
    switchBotProvider: vi.fn(),
    saveProviderModel: vi.fn(),
}));

const CLAUDE_SUMMARY: BotProviderSummary = {
    provider: 'claude', label: 'Claude', model: 'sonnet', modelOptions: [], selectedModel: null, selectedEffort: null, effortOptions: [],
};

const PROVIDERS: ProviderChoiceSummary[] = [
    { id: 'claude', label: 'Claude', isConnected: true },
    { id: 'gemini', label: 'Gemini', isConnected: true },
    { id: 'chatgpt', label: 'ChatGPT', isConnected: false },
];

describe('ProviderPicker', () => {
    beforeEach(() => {
        vi.mocked(getBotProvider)
            .mockResolvedValue(CLAUDE_SUMMARY);
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

        const current = await screen.findByRole('button', { name: 'Claude' });
        const other = screen.getByRole('button', { name: 'Gemini' });

        expect(current.getAttribute('aria-pressed'))
            .toBe('true');
        expect(other.getAttribute('aria-pressed'))
            .toBe('false');
        expect(screen.getByRole('button', { name: 'Connect ChatGPT' }))
            .toBeTruthy();
    });

    it('switches the bot to the provider the owner picks and closes the menu', async () => {
        vi.mocked(switchBotProvider)
            .mockResolvedValue({ ...CLAUDE_SUMMARY, provider: 'gemini', label: 'Gemini', model: null });

        render(<ProviderPicker botId="bot-1" onOpenSetupChat={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'AI provider' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Gemini' }));

        await waitFor(() => {
            expect(screen.queryByRole('dialog'))
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
        fireEvent.click(await screen.findByRole('button', { name: 'Connect ChatGPT' }));

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
        fireEvent.click(await screen.findByRole('button', { name: 'Gemini' }));

        expect(await screen.findByText('The provider could not be changed.'))
            .toBeTruthy();
    });

    it('saves the selected model and effort offered by the current provider', async () => {
        const chatgpt: BotProviderSummary = {
            provider: 'chatgpt', label: 'ChatGPT', model: 'gpt-6-luna',
            modelOptions: [
                { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low', 'medium'] },
                { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['high'] },
            ],
            selectedModel: null, selectedEffort: null, effortOptions: ['low', 'medium'],
        };

        vi.mocked(getBotProvider)
            .mockResolvedValue(chatgpt);
        vi.mocked(saveProviderModel)
            .mockResolvedValue({ ...chatgpt, selectedModel: 'gpt-6-luna', selectedEffort: 'low' });

        render(<ProviderPicker botId="bot-1" onOpenSetupChat={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'AI provider' }));
        fireEvent.change(await screen.findByRole('combobox', { name: 'Model' }), { target: { value: 'gpt-6-luna' } });
        fireEvent.change(screen.getByRole('combobox', { name: 'Effort' }), { target: { value: 'low' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save model' }));

        await waitFor(() => {
            expect(saveProviderModel)
                .toHaveBeenCalledWith('bot-1', 'gpt-6-luna', 'low');
        });
        expect(await screen.findByText('gpt-6-luna'))
            .toBeTruthy();
    });

    it('closes the menu with Escape', async () => {
        render(<ProviderPicker botId="bot-1" onOpenSetupChat={() => {}} />);

        fireEvent.click(await screen.findByRole('button', { name: 'AI provider' }));
        await screen.findByRole('dialog', { name: 'AI provider settings' });
        fireEvent.keyDown(document, { key: 'Escape' });

        await waitFor(() => {
            expect(screen.queryByRole('dialog'))
                .toBeNull();
        });
    });
});
