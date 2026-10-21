// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotRoutine } from '../../shared/routineTypes.ts';
import { RoutinesPanel } from './RoutinesPanel.tsx';

interface FetchCall {
    url: string;
    method: string;
}

const DAILY_ROUTINE: BotRoutine = {
    id: 'r1',
    name: 'Morning inbox',
    prompt: 'Check my inbox.',
    schedule: { kind: 'daily', hour: 9, minute: 5 },
    isEnabled: true,
    nextRunAt: Date.UTC(2026, 9, 22, 9, 5),
    lastRunAt: Date.UTC(2026, 9, 21, 9, 5),
};

function stubRoutinesApi(initialRoutines: BotRoutine[]): FetchCall[] {
    const calls: FetchCall[] = [];

    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';

        calls.push({ url: input, method });

        if (method === 'GET') {
            return Promise.resolve(Response.json(initialRoutines));
        }

        return Promise.resolve(new Response(null, { status: 204 }));
    });

    return calls;
}

describe('RoutinesPanel', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('says there are no routines and how the bot makes one', async () => {
        stubRoutinesApi([]);

        render(<RoutinesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByText('No routines yet.'))
            .toBeTruthy();
        expect(screen.getByText('The bot creates routines when you ask it in the chat.', { exact: false }))
            .toBeTruthy();
    });

    it('lists each routine with its schedule and UTC run times', async () => {
        stubRoutinesApi([DAILY_ROUTINE]);

        render(<RoutinesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByText('Check my inbox.'))
            .toBeTruthy();
        expect(screen.getByText('Morning inbox'))
            .toBeTruthy();
        expect(screen.getByText('Every day at 09:05 UTC'))
            .toBeTruthy();
        expect(screen.getByText('Next run: 2026-10-22 09:05 UTC'))
            .toBeTruthy();
        expect(screen.getByText('Last run: 2026-10-21 09:05 UTC'))
            .toBeTruthy();
    });

    it('drops a routine that the server no longer has', async () => {
        vi.stubGlobal('fetch', (_input: string, init: RequestInit = {}) => {
            if (init.method === 'DELETE') {
                return Promise.resolve(Response.json({ error: 'This bot has no routine with this id.' }, { status: 404 }));
            }

            return Promise.resolve(Response.json([DAILY_ROUTINE]));
        });

        render(<RoutinesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);
        await screen.findByText('Check my inbox.');

        fireEvent.click(screen.getByRole('button', { name: 'Remove routine: Morning inbox' }));

        await waitFor(() => {
            expect(screen.queryByText('Check my inbox.'))
                .toBeNull();
        });
        expect(screen.queryByRole('alert'))
            .toBeNull();
    });

    it('marks a routine that is turned off', async () => {
        const pausedRoutine: BotRoutine = { ...DAILY_ROUTINE, isEnabled: false };

        stubRoutinesApi([pausedRoutine]);

        render(<RoutinesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByText('Every day at 09:05 UTC (off)'))
            .toBeTruthy();
    });

    it('removes a routine from the list after the server deletes it', async () => {
        const calls = stubRoutinesApi([DAILY_ROUTINE]);

        render(<RoutinesPanel botId="bot 1" botName="Ana" onClose={vi.fn()} />);
        await screen.findByText('Check my inbox.');

        fireEvent.click(screen.getByRole('button', { name: 'Remove routine: Morning inbox' }));

        await waitFor(() => {
            expect(screen.queryByText('Check my inbox.'))
                .toBeNull();
        });
        expect(calls.at(-1))
            .toEqual({ url: '/api/bots/bot%201/routines/r1', method: 'DELETE' });
    });
});
