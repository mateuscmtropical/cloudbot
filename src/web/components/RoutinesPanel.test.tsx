// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '../apiClient.ts';
import { getWorkSettings, listProviders, listRoutines, RequestFailedError, setRoutineWork } from '../apiClient.ts';
import type { ProviderChoiceSummary, WorkKindSummary } from '../../shared/providerTypes.ts';
import type { BotRoutine } from '../../shared/routineTypes.ts';
import { RoutinesPanel } from './RoutinesPanel.tsx';

vi.mock('../apiClient.ts', async (importOriginal) => {
    const original = await importOriginal<typeof ApiClient>();

    return { ...original, getWorkSettings: vi.fn(), listProviders: vi.fn(), listRoutines: vi.fn(), setRoutineWork: vi.fn() };
});

const BOT = { id: 'bot-1', name: 'Nimbus' };

const GEMINI_ROUTINE: BotRoutine = {
    id: 'routine-1',
    name: 'Morning digest',
    prompt: 'Summarize the news',
    schedule: { kind: 'daily', hour: 8, minute: 0 },
    isEnabled: true,
    isQuiet: false,
    nextRunAt: 1,
    lastRunAt: null,
    provider: 'gemini',
    model: 'flash',
    effort: null,
};

const DEFAULT_ROUTINE: BotRoutine = { ...GEMINI_ROUTINE, id: 'routine-2', name: 'Weekly review', provider: null, model: null, effort: null };

const ROUTINES_WORK: WorkKindSummary = {
    kind: 'routines',
    label: 'Routines',
    provider: null,
    usedProvider: 'claude',
    usedProviderLabel: 'Claude',
    usedModel: 'claude-sonnet-5-5',
    usedEffort: null,
    selectedModel: null,
    selectedEffort: null,
    modelOptions: [{ id: 'haiku', label: 'Haiku', efforts: ['low', 'high'] }],
    effortOptions: ['low', 'high'],
    allowedProviders: null,
    choosableProviders: ['claude', 'gemini'],
    providerModels: {
        claude: [{ id: 'haiku', label: 'Haiku', efforts: ['low', 'high'] }],
        gemini: [
            { id: 'flash', label: 'Flash', efforts: ['low', 'high'] },
            { id: 'pro', label: 'Pro', efforts: ['high'] },
        ],
    },
};

const PROVIDERS: ProviderChoiceSummary[] = [
    { id: 'claude', label: 'Claude', isConnected: true },
    { id: 'gemini', label: 'Gemini', isConnected: true },
    { id: 'chatgpt', label: 'ChatGPT', isConnected: false },
];

function renderPanel(): void {
    render(<RoutinesPanel bot={BOT} onClose={vi.fn()} />);
}

describe('RoutinesPanel', () => {
    afterEach(() => {
        cleanup();
        vi.resetAllMocks();
    });

    it('shows the provider and model of each routine, or the routines default', async () => {
        vi.mocked(listRoutines)
            .mockResolvedValue([GEMINI_ROUTINE, DEFAULT_ROUTINE]);
        vi.mocked(getWorkSettings)
            .mockResolvedValue([ROUTINES_WORK]);
        vi.mocked(listProviders)
            .mockResolvedValue(PROVIDERS);

        renderPanel();

        expect(await screen.findByText('Gemini · flash'))
            .toBeTruthy();
        expect(screen.getAllByText('Routines default').length)
            .toBeGreaterThan(0);
    });

    it('saves a new provider and clears the model and effort', async () => {
        vi.mocked(listRoutines)
            .mockResolvedValue([DEFAULT_ROUTINE]);
        vi.mocked(getWorkSettings)
            .mockResolvedValue([ROUTINES_WORK]);
        vi.mocked(listProviders)
            .mockResolvedValue(PROVIDERS);
        vi.mocked(setRoutineWork)
            .mockResolvedValue({ ...DEFAULT_ROUTINE, provider: 'gemini' });

        renderPanel();

        fireEvent.change(await screen.findByRole('combobox', { name: 'Weekly review provider' }), { target: { value: 'gemini' } });

        await waitFor(() => {
            expect(setRoutineWork)
                .toHaveBeenCalledWith('bot-1', 'routine-2', { provider: 'gemini', model: null, effort: null });
        });
    });

    it('saves a model of the provider the routines run on', async () => {
        vi.mocked(listRoutines)
            .mockResolvedValue([DEFAULT_ROUTINE]);
        vi.mocked(getWorkSettings)
            .mockResolvedValue([ROUTINES_WORK]);
        vi.mocked(listProviders)
            .mockResolvedValue(PROVIDERS);
        vi.mocked(setRoutineWork)
            .mockResolvedValue({ ...DEFAULT_ROUTINE, model: 'haiku' });

        renderPanel();

        fireEvent.change(await screen.findByRole('combobox', { name: 'Weekly review model' }), { target: { value: 'haiku' } });

        await waitFor(() => {
            expect(setRoutineWork)
                .toHaveBeenCalledWith('bot-1', 'routine-2', { provider: null, model: 'haiku', effort: null });
        });
    });

    it('lists the models of the routine provider, and saves the effort of the chosen model', async () => {
        vi.mocked(listRoutines)
            .mockResolvedValue([GEMINI_ROUTINE]);
        vi.mocked(getWorkSettings)
            .mockResolvedValue([ROUTINES_WORK]);
        vi.mocked(listProviders)
            .mockResolvedValue(PROVIDERS);
        vi.mocked(setRoutineWork)
            .mockResolvedValue({ ...GEMINI_ROUTINE, effort: 'high' });

        renderPanel();

        const effort = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Morning digest effort' });

        expect([...effort.options].map(option => option.text))
            .toEqual(['Default', 'low', 'high']);
        fireEvent.change(effort, { target: { value: 'high' } });

        await waitFor(() => {
            expect(setRoutineWork)
                .toHaveBeenCalledWith('bot-1', 'routine-1', { provider: 'gemini', model: 'flash', effort: 'high' });
        });
    });

    it('offers the models of another connected provider', async () => {
        vi.mocked(listRoutines)
            .mockResolvedValue([DEFAULT_ROUTINE]);
        vi.mocked(getWorkSettings)
            .mockResolvedValue([ROUTINES_WORK]);
        vi.mocked(listProviders)
            .mockResolvedValue(PROVIDERS);
        vi.mocked(setRoutineWork)
            .mockResolvedValue({ ...DEFAULT_ROUTINE, provider: 'gemini' });

        renderPanel();

        fireEvent.change(await screen.findByRole('combobox', { name: 'Weekly review provider' }), { target: { value: 'gemini' } });

        const model = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Weekly review model' });

        expect([...model.options].map(option => option.text))
            .toEqual(['Default', 'Flash', 'Pro']);
        expect(setRoutineWork)
            .toHaveBeenCalledWith('bot-1', 'routine-2', { provider: 'gemini', model: null, effort: null });
    });

    it('shows the reason when the server refuses the change', async () => {
        vi.mocked(listRoutines)
            .mockResolvedValue([DEFAULT_ROUTINE]);
        vi.mocked(getWorkSettings)
            .mockResolvedValue([ROUTINES_WORK]);
        vi.mocked(listProviders)
            .mockResolvedValue(PROVIDERS);
        vi.mocked(setRoutineWork)
            .mockRejectedValue(new RequestFailedError('/api/bots/bot-1/routines/routine-2/work', 400, 'That provider is not connected. Connect it first.'));

        renderPanel();

        fireEvent.change(await screen.findByRole('combobox', { name: 'Weekly review provider' }), { target: { value: 'gemini' } });

        expect(await screen.findByText('That provider is not connected. Connect it first.'))
            .toBeTruthy();
    });
});
