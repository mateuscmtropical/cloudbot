// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '../apiClient.ts';
import { listTriggers, removeTrigger, RequestFailedError, setTriggerEnabled } from '../apiClient.ts';
import type { BotTrigger } from '../../shared/triggerTypes.ts';
import { TriggersPanel } from './TriggersPanel.tsx';

vi.mock('../apiClient.ts', async (importOriginal) => {
    const original = await importOriginal<typeof ApiClient>();

    return { ...original, listTriggers: vi.fn(), removeTrigger: vi.fn(), setTriggerEnabled: vi.fn() };
});

const BOT = { id: 'bot-1', name: 'Nimbus' };

const MAIL_TRIGGER: BotTrigger = {
    id: 'trigger-1',
    name: 'Mail from Ana',
    source: 'gmail',
    sourceLabel: 'Gmail',
    target: 'from:ana@example.com',
    prompt: 'Tell me what she wants',
    intervalMinutes: 15,
    isEnabled: true,
    lastCheckedAt: null,
    nextCheckAt: 1,
    createdAt: 1,
};

function renderPanel(): void {
    render(<TriggersPanel bot={BOT} onClose={vi.fn()} />);
}

describe('TriggersPanel', () => {
    afterEach(() => {
        cleanup();
        vi.resetAllMocks();
    });

    it('lists each trigger with its source, target, interval and last check', async () => {
        vi.mocked(listTriggers)
            .mockResolvedValue([MAIL_TRIGGER, { ...MAIL_TRIGGER, id: 'trigger-2', name: 'Issues', sourceLabel: 'GitHub issues', target: 'o/r', isEnabled: false, lastCheckedAt: Date.UTC(2026, 10, 1) }]);

        renderPanel();

        expect(await screen.findByText('Mail from Ana'))
            .toBeTruthy();
        expect(screen.getByText('Gmail'))
            .toBeTruthy();
        expect(screen.getByText('from:ana@example.com'))
            .toBeTruthy();
        expect(screen.getByText('Waiting for the first check'))
            .toBeTruthy();
        expect(screen.getByText('Paused'))
            .toBeTruthy();
        expect(screen.getAllByText('15 minutes'))
            .toHaveLength(2);
        expect(screen.getByRole('button', { name: 'Resume' }))
            .toBeTruthy();
    });

    it('says when there are no triggers', async () => {
        vi.mocked(listTriggers)
            .mockResolvedValue([]);

        renderPanel();

        expect(await screen.findByText('No app triggers yet.'))
            .toBeTruthy();
    });

    it('pauses a trigger and shows the saved state', async () => {
        vi.mocked(listTriggers)
            .mockResolvedValue([MAIL_TRIGGER]);
        vi.mocked(setTriggerEnabled)
            .mockResolvedValue({ ...MAIL_TRIGGER, isEnabled: false });

        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));

        await waitFor(() => {
            expect(setTriggerEnabled)
                .toHaveBeenCalledWith('bot-1', 'trigger-1', false);
        });
        expect(await screen.findByRole('button', { name: 'Resume' }))
            .toBeTruthy();
    });

    it('shows the reason when a change is refused', async () => {
        vi.mocked(listTriggers)
            .mockResolvedValue([MAIL_TRIGGER]);
        vi.mocked(setTriggerEnabled)
            .mockRejectedValue(new RequestFailedError('/x', 404, 'This bot has no app trigger with this id.'));

        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));

        expect((await screen.findByRole('alert')).textContent)
            .toBe('This bot has no app trigger with this id.');
    });

    it('deletes a trigger after the owner confirms', async () => {
        vi.mocked(listTriggers)
            .mockResolvedValue([MAIL_TRIGGER]);
        vi.mocked(removeTrigger)
            .mockResolvedValue(undefined);

        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: 'Delete trigger' }));
        expect(removeTrigger)
            .not.toHaveBeenCalled();
        fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

        await waitFor(() => {
            expect(removeTrigger)
                .toHaveBeenCalledWith('bot-1', 'trigger-1');
        });
        await waitFor(() => {
            expect(screen.queryByText('Mail from Ana'))
                .toBeNull();
        });
    });
});
