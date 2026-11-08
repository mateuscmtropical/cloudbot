// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotProviderSummary, ProviderChoiceSummary } from '../../shared/providerTypes.ts';
import { getBotProvider, getProviderUsage, getWorkSettings, listProviders, savePermissionMode, saveProviderModel, startProviderConnect, switchBotProvider } from '../apiClient.ts';
import { ProviderPicker } from './ProviderPicker.tsx';

vi.mock('../apiClient.ts', () => ({
    getBotProvider: vi.fn(),
    getWorkSettings: vi.fn(),
    getProviderUsage: vi.fn(),
    listProviders: vi.fn(),
    startProviderConnect: vi.fn(),
    switchBotProvider: vi.fn(),
    saveProviderModel: vi.fn(),
    savePermissionMode: vi.fn(),
}));

const CLAUDE_SUMMARY: BotProviderSummary = {
    provider: 'claude', label: 'Claude', model: 'sonnet', modelOptions: [], selectedModel: null, selectedEffort: null, effortOptions: [], permissionMode: 'auto',
};

const CHATGPT_SUMMARY: BotProviderSummary = {
    provider: 'chatgpt', label: 'ChatGPT', model: 'gpt-6-luna',
    modelOptions: [
        { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low', 'medium'] },
        { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['high'] },
    ],
    selectedModel: 'gpt-6-luna', selectedEffort: 'low', effortOptions: ['low', 'medium'], permissionMode: 'auto',
};

const PROVIDERS: ProviderChoiceSummary[] = [
    { id: 'claude', label: 'Claude', isConnected: true },
    { id: 'gemini', label: 'Gemini', isConnected: true },
    { id: 'chatgpt', label: 'ChatGPT', isConnected: false },
];

function renderPicker(onOpenSetupChat: (setupBotId: string) => void = () => {}, onClose: () => void = () => {}): void {
    render(<ProviderPicker botId="bot-1" isOpen={true} onOpenSetupChat={onOpenSetupChat} onClose={onClose} />);
}

describe('ProviderPicker', () => {
    beforeEach(() => {
        vi.mocked(getBotProvider)
            .mockResolvedValue(CLAUDE_SUMMARY);
        vi.mocked(listProviders)
            .mockResolvedValue(PROVIDERS);
        vi.mocked(getWorkSettings)
            .mockResolvedValue([]);
        vi.mocked(getProviderUsage)
            .mockResolvedValue([]);
    });

    afterEach(() => {
        cleanup();
        vi.resetAllMocks();
    });

    it('shows the model the provider reports on the row in use', async () => {
        renderPicker();

        const current = await screen.findByRole('button', { pressed: true });

        expect(current.textContent)
            .toContain('Claude');
        expect(current.textContent)
            .toContain('sonnet');
    });

    it('saves the permission choice and warns about YOLO', async () => {
        vi.mocked(savePermissionMode)
            .mockResolvedValue({ ...CLAUDE_SUMMARY, permissionMode: 'yolo' });

        renderPicker();

        fireEvent.change(await screen.findByRole('combobox', { name: 'Permissions' }), { target: { value: 'yolo' } });

        expect(await screen.findByText(/You take that risk/))
            .toBeTruthy();
        expect(savePermissionMode)
            .toHaveBeenCalledWith('bot-1', 'yolo');
    });

    it('takes the permission choice back when the server refuses it', async () => {
        vi.mocked(savePermissionMode)
            .mockRejectedValue(new Error('refused'));

        renderPicker();

        const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Permissions' });

        fireEvent.change(select, { target: { value: 'yolo' } });

        expect(await screen.findByText('The permissions could not be changed.'))
            .toBeTruthy();
        expect(select.value)
            .toBe('auto');
        expect(screen.queryByText(/You take that risk/))
            .toBeNull();
    });

    it('says so when the settings cannot be read', async () => {
        vi.mocked(getBotProvider)
            .mockRejectedValue(new Error('offline'));

        renderPicker();

        expect(await screen.findByText('The settings could not be loaded.'))
            .toBeTruthy();
    });

    it('lists the providers, marks the one in use and offers Connect for the others', async () => {
        renderPicker();

        const current = await screen.findByRole('button', { name: 'Claude sonnet' });
        const other = screen.getByRole('button', { name: 'Gemini' });

        expect(current.getAttribute('aria-pressed'))
            .toBe('true');
        expect(other.getAttribute('aria-pressed'))
            .toBe('false');
        expect(screen.getByRole('button', { name: 'Connect ChatGPT' }))
            .toBeTruthy();
    });

    it('switches the bot to the provider the owner picks and keeps the panel open', async () => {
        vi.mocked(switchBotProvider)
            .mockResolvedValue({ ...CLAUDE_SUMMARY, provider: 'gemini', label: 'Gemini', model: null });
        const onClose = vi.fn();

        renderPicker(() => {}, onClose);

        fireEvent.click(await screen.findByRole('button', { name: 'Gemini' }));

        expect(screen.getByRole('button', { name: 'Gemini' })
            .getAttribute('aria-pressed'))
            .toBe('true');
        await waitFor(() => {
            expect(switchBotProvider)
                .toHaveBeenCalledWith('bot-1', 'gemini');
        });
        expect(onClose)
            .not.toHaveBeenCalled();
    });

    it('does nothing when the owner taps the provider in use', async () => {
        renderPicker();

        fireEvent.click(await screen.findByRole('button', { name: 'Claude sonnet' }));

        expect(switchBotProvider)
            .not.toHaveBeenCalled();
    });

    it('opens the setup chat and closes the panel when the owner connects a provider', async () => {
        vi.mocked(startProviderConnect)
            .mockResolvedValue({ botId: 'setup-bot' });
        const onOpenSetupChat = vi.fn();
        const onClose = vi.fn();

        renderPicker(onOpenSetupChat, onClose);

        fireEvent.click(await screen.findByRole('button', { name: 'Connect ChatGPT' }));

        await waitFor(() => {
            expect(onOpenSetupChat)
                .toHaveBeenCalledWith('setup-bot');
        });
        expect(startProviderConnect)
            .toHaveBeenCalledWith('chatgpt');
        expect(onClose)
            .toHaveBeenCalledOnce();
    });

    it('offers the models and efforts a Claude summary lists', async () => {
        vi.mocked(getBotProvider)
            .mockResolvedValue({
                ...CLAUDE_SUMMARY,
                modelOptions: [{ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'max'] }, { id: 'haiku', label: 'Haiku', efforts: ['low', 'max'] }],
                effortOptions: ['low', 'max'],
            });

        renderPicker();

        expect(await screen.findByRole('combobox', { name: 'Model' }))
            .toBeTruthy();
        expect(screen.getByRole('combobox', { name: 'Effort' }))
            .toBeTruthy();
    });

    it('connects from anywhere on the row of a provider', async () => {
        vi.mocked(startProviderConnect)
            .mockResolvedValue({ botId: 'setup-bot' });

        renderPicker();

        const row = await screen.findByRole('button', { name: 'Connect ChatGPT' });

        expect(row.className)
            .toBe('provider-row');

        fireEvent.click(within(row)
            .getByText('ChatGPT'));

        expect(startProviderConnect)
            .toHaveBeenCalledWith('chatgpt');
    });

    it('marks the old provider again when the change is refused', async () => {
        vi.mocked(switchBotProvider)
            .mockRejectedValue(new Error('refused'));

        renderPicker();

        fireEvent.click(await screen.findByRole('button', { name: 'Gemini' }));

        expect(await screen.findByText('The provider could not be changed.'))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Claude sonnet' })
            .getAttribute('aria-pressed'))
            .toBe('true');
    });

    it('saves the effort as soon as it changes', async () => {
        vi.mocked(getBotProvider)
            .mockResolvedValue(CHATGPT_SUMMARY);
        vi.mocked(saveProviderModel)
            .mockResolvedValue({ ...CHATGPT_SUMMARY, selectedEffort: 'medium' });

        renderPicker();
        fireEvent.change(await screen.findByRole('combobox', { name: 'Effort' }), { target: { value: 'medium' } });

        await waitFor(() => {
            expect(saveProviderModel)
                .toHaveBeenCalledWith('bot-1', 'gpt-6-luna', 'medium');
        });
        expect(screen.queryByRole('button', { name: 'Save model' }))
            .toBeNull();
    });

    it('drops an effort the new model does not offer', async () => {
        vi.mocked(getBotProvider)
            .mockResolvedValue(CHATGPT_SUMMARY);
        vi.mocked(saveProviderModel)
            .mockResolvedValue({ ...CHATGPT_SUMMARY, selectedModel: 'gpt-6-astra', selectedEffort: null });

        renderPicker();
        fireEvent.change(await screen.findByRole('combobox', { name: 'Model' }), { target: { value: 'gpt-6-astra' } });

        await waitFor(() => {
            expect(saveProviderModel)
                .toHaveBeenCalledWith('bot-1', 'gpt-6-astra', null);
        });
    });

    it('reads when the bot shows and when the panel opens, not when a message arrives or it closes', async () => {
        const view = render(<ProviderPicker botId="bot-1" isOpen={false} onOpenSetupChat={() => {}} onClose={() => {}} />);

        await screen.findByRole('button', { name: 'Gemini' });
        expect(getBotProvider)
            .toHaveBeenCalledTimes(1);

        view.rerender(<ProviderPicker botId="bot-1" isOpen={false} onOpenSetupChat={() => {}} onClose={() => {}} />);
        expect(getBotProvider)
            .toHaveBeenCalledTimes(1);

        view.rerender(<ProviderPicker botId="bot-1" isOpen={true} onOpenSetupChat={() => {}} onClose={() => {}} />);
        expect(getBotProvider)
            .toHaveBeenCalledTimes(2);

        view.rerender(<ProviderPicker botId="bot-1" isOpen={false} onOpenSetupChat={() => {}} onClose={() => {}} />);
        expect(getBotProvider)
            .toHaveBeenCalledTimes(2);
    });
});
