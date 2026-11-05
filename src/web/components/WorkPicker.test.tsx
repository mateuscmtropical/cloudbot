// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderChoiceSummary, WorkKindSummary } from '../../shared/providerTypes.ts';
import { getWorkSettings, saveWorkChoice } from '../apiClient.ts';
import { WorkPicker } from './WorkPicker.tsx';

vi.mock('../apiClient.ts', () => ({
    getWorkSettings: vi.fn(),
    saveWorkChoice: vi.fn(),
}));

const REVIEW: WorkKindSummary = {
    kind: 'review',
    label: 'Review',
    provider: null,
    usedProvider: 'claude',
    usedProviderLabel: 'Claude',
    usedModel: 'claude-sonnet-5-5',
    usedEffort: null,
    selectedModel: null,
    selectedEffort: null,
    modelOptions: [{ id: 'haiku', label: 'Haiku', efforts: ['low', 'high'] }],
    effortOptions: ['low', 'high'],
    allowedProviders: ['claude', 'chatgpt'],
};

const PROVIDERS: ProviderChoiceSummary[] = [
    { id: 'claude', label: 'Claude', isConnected: true },
    { id: 'chatgpt', label: 'ChatGPT', isConnected: true },
    { id: 'kimi', label: 'Kimi', isConnected: true },
    { id: 'gemini', label: 'Gemini', isConnected: false },
];

function renderPicker(): void {
    render(<WorkPicker botId="bot-1" providers={PROVIDERS} refreshKey="claude" />);
}

describe('WorkPicker', () => {
    afterEach(() => {
        cleanup();
        vi.resetAllMocks();
    });

    it('shows the real names in use and offers only connected providers the work can run on', async () => {
        vi.mocked(getWorkSettings)
            .mockResolvedValue([REVIEW]);

        renderPicker();

        expect(await screen.findByText('Claude, claude-sonnet-5-5, Default effort'))
            .toBeTruthy();

        const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Review provider', hidden: true });
        const labels = [...select.options].map(option => option.text);

        expect(labels)
            .toEqual(['Same as chat', 'Claude', 'ChatGPT']);
    });

    it('saves a new provider without the model of the old one', async () => {
        vi.mocked(getWorkSettings)
            .mockResolvedValue([{ ...REVIEW, selectedModel: 'haiku', selectedEffort: 'low' }]);
        vi.mocked(saveWorkChoice)
            .mockResolvedValue([{ ...REVIEW, provider: 'chatgpt' }]);

        renderPicker();

        fireEvent.change(await screen.findByRole('combobox', { name: 'Review provider', hidden: true }), { target: { value: 'chatgpt' } });

        await waitFor(() => {
            expect(saveWorkChoice)
                .toHaveBeenCalledWith('bot-1', 'review', { provider: 'chatgpt', model: null, effort: null });
        });
    });

    it('says so when a choice is refused', async () => {
        vi.mocked(getWorkSettings)
            .mockResolvedValue([REVIEW]);
        vi.mocked(saveWorkChoice)
            .mockRejectedValue(new Error('refused'));

        renderPicker();

        fireEvent.change(await screen.findByRole('combobox', { name: 'Review effort', hidden: true }), { target: { value: 'high' } });

        expect(await screen.findByText('The choice could not be saved.'))
            .toBeTruthy();
    });
});
