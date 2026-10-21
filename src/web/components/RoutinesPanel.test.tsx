// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotRoutine } from '../../shared/routineTypes.ts';
import type { BotWatch } from '../../shared/watchTypes.ts';
import type { BotWebhook, CreatedBotWebhook } from '../../shared/webhookTypes.ts';
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

const DEPLOY_WEBHOOK: BotWebhook = { id: 'w1', name: 'Deploy', createdAt: Date.UTC(2026, 9, 21, 11, 0), refusals: [] };
const CREATED_URL = 'https://bot.example.com/hooks/fresh-token';

// Routes each request by its method and path. Routines and webhooks are separate lists.
function stubPanelApi(options: { routines: BotRoutine[]; webhooks: BotWebhook[] }): FetchCall[] {
    const calls: FetchCall[] = [];

    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';

        calls.push({ url: input, method });

        if (method === 'GET' && input.endsWith('/webhooks')) {
            return Promise.resolve(Response.json(options.webhooks));
        }

        if (method === 'GET' && input.endsWith('/watches')) {
            return Promise.resolve(Response.json([]));
        }

        if (method === 'GET') {
            return Promise.resolve(Response.json(options.routines));
        }

        if (method === 'POST' && input.endsWith('/webhooks')) {
            const created: CreatedBotWebhook = { id: 'w2', name: 'Build', createdAt: Date.UTC(2026, 9, 21, 12, 0), refusals: [], url: CREATED_URL };

            return Promise.resolve(Response.json(created, { status: 201 }));
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
        stubPanelApi({ routines: [], webhooks: [] });

        render(<RoutinesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByText('No routines yet.'))
            .toBeTruthy();
        expect(screen.getByText('The bot creates routines when you ask it in the chat.', { exact: false }))
            .toBeTruthy();
    });

    it('lists each routine with its schedule and UTC run times', async () => {
        stubPanelApi({ routines: [DAILY_ROUTINE], webhooks: [] });

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
        vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
            if (init.method === 'DELETE') {
                return Promise.resolve(Response.json({ error: 'This bot has no routine with this id.' }, { status: 404 }));
            }

            if (input.endsWith('/webhooks') || input.endsWith('/watches')) {
                return Promise.resolve(Response.json([]));
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

        stubPanelApi({ routines: [pausedRoutine], webhooks: [] });

        render(<RoutinesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByText('Every day at 09:05 UTC (off)'))
            .toBeTruthy();
    });

    it('removes a routine from the list after the server deletes it', async () => {
        const calls = stubPanelApi({ routines: [DAILY_ROUTINE], webhooks: [] });

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

    it('lists the webhooks by name, without any URL', async () => {
        stubPanelApi({ routines: [], webhooks: [DEPLOY_WEBHOOK] });

        render(<RoutinesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByText('Deploy'))
            .toBeTruthy();
        expect(screen.queryByRole('textbox', { name: 'Webhook URL' }))
            .toBeNull();
        expect(screen.getByRole('button', { name: 'Remove webhook: Deploy' }))
            .toBeTruthy();
    });

    it('shows the refused calls of a webhook, with only the reason', async () => {
        const refusedWebhook: BotWebhook = {
            ...DEPLOY_WEBHOOK,
            refusals: [{ time: Date.UTC(2026, 9, 21, 11, 30), reason: 'queue full' }],
        };

        stubPanelApi({ routines: [], webhooks: [refusedWebhook] });

        render(<RoutinesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByText('Refused calls: 1'))
            .toBeTruthy();
        expect(screen.getByRole('list', { name: 'Refused calls for Deploy' }).textContent)
            .toContain('queue full');
    });

    it('creates a webhook and shows its URL once, with a warning to keep it secret', async () => {
        const calls = stubPanelApi({ routines: [], webhooks: [] });

        render(<RoutinesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);
        await screen.findByText('No webhooks yet.');

        fireEvent.change(screen.getByLabelText('Webhook name'), { target: { value: 'Build' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create' }));

        const urlField = await screen.findByRole('textbox', { name: 'Webhook URL' });

        expect((urlField as HTMLInputElement).value)
            .toBe(CREATED_URL);
        expect((urlField as HTMLInputElement).readOnly)
            .toBe(true);
        expect(screen.getByText('shown only now', { exact: false }))
            .toBeTruthy();
        expect(calls.at(-1))
            .toEqual({ url: '/api/bots/bot/webhooks', method: 'POST' });
        expect(screen.getByText('Build'))
            .toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Hide URL' }));

        expect(screen.queryByRole('textbox', { name: 'Webhook URL' }))
            .toBeNull();
    });

    it('removes a webhook from the list', async () => {
        const calls = stubPanelApi({ routines: [], webhooks: [DEPLOY_WEBHOOK] });

        render(<RoutinesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);
        await screen.findByText('Deploy');

        fireEvent.click(screen.getByRole('button', { name: 'Remove webhook: Deploy' }));

        await waitFor(() => {
            expect(screen.queryByText('Deploy'))
                .toBeNull();
        });
        expect(calls.at(-1))
            .toEqual({ url: '/api/bots/bot/webhooks/w1', method: 'DELETE' });
    });

    it('lists the page watches of the bot and removes one', async () => {
        const watch: BotWatch = {
            id: 'pw1',
            name: 'Bread prices',
            url: 'https://shop.example.test/',
            intervalMinutes: 60,
            keyword: 'bread',
            lastCheckedAt: Date.UTC(2026, 9, 21, 10, 0),
            nextCheckAt: Date.UTC(2026, 9, 21, 11, 0),
            createdAt: Date.UTC(2026, 9, 21, 9, 0),
        };
        const calls: FetchCall[] = [];

        vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
            const method = init.method ?? 'GET';

            calls.push({ url: input, method });

            if (method === 'GET' && input.endsWith('/watches')) {
                return Promise.resolve(Response.json([watch]));
            }

            if (method === 'GET' && input.endsWith('/webhooks')) {
                return Promise.resolve(Response.json([]));
            }

            if (method === 'GET') {
                return Promise.resolve(Response.json([]));
            }

            return Promise.resolve(new Response(null, { status: 204 }));
        });

        render(<RoutinesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByText('Bread prices'))
            .toBeDefined();
        expect(screen.getByText(/Every 60 minutes/))
            .toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: 'Remove page watch: Bread prices' }));

        await waitFor(() => {
            expect(screen.queryByText('Bread prices'))
                .toBeNull();
        });
        expect(calls.at(-1))
            .toEqual({ url: '/api/bots/bot/watches/pw1', method: 'DELETE' });
    });
});
