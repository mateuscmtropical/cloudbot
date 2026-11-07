// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActionLogPanel } from './ActionLogPanel.tsx';

const BOTS = [{ id: 'bot-1', name: 'Nimbus' }];

function stubLog(body: unknown, status = 200): ReturnType<typeof vi.fn> {
    const fetchStub = vi.fn(() => Promise.resolve(Response.json(body, { status })));

    vi.stubGlobal('fetch', fetchStub);

    return fetchStub;
}

describe('ActionLogPanel', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('shows each action with its outcome and bot, and names a deleted bot', async () => {
        stubLog([
            { at: '2026-11-05T10:00:00.000Z', botId: 'bot-1', event: 'review', tool: 'mcp__cloudbot__browser_open', decision: 'owner_denied', durationMs: 2500 },
            { at: '2026-11-05T09:00:00.000Z', botId: 'gone', event: 'turn_error' },
        ]);
        render(<ActionLogPanel bots={BOTS} onClose={vi.fn()} />);

        expect(await screen.findByText('browser open'))
            .toBeTruthy();
        expect(screen.getByText(/Denied, 2\.5 s\. Nimbus/))
            .toBeTruthy();
        expect(screen.getByText('The turn failed'))
            .toBeTruthy();
        expect(screen.getByText(/Error\. A deleted bot/))
            .toBeTruthy();
    });

    it('asks the server for the bot the owner picks', async () => {
        const fetchStub = stubLog([]);

        render(<ActionLogPanel bots={BOTS} onClose={vi.fn()} />);
        expect(await screen.findByText('No actions yet.'))
            .toBeTruthy();
        fireEvent.change(screen.getByLabelText('Show the actions of'), { target: { value: 'bot-1' } });

        await waitFor(() => {
            expect(fetchStub)
                .toHaveBeenCalledWith('/api/action-log?botId=bot-1', {});
        });
    });

    it('shows who decided and the card line, and filters by outcome', async () => {
        const fetchStub = stubLog([
            { at: '2026-11-05T10:00:00.000Z', botId: 'bot-1', event: 'review', tool: 'mcp__cloudbot__email_send', decision: 'owner_approved', decidedBy: 'Ana (admin)', summary: 'Send an email to Ana' },
        ]);

        render(<ActionLogPanel bots={BOTS} onClose={vi.fn()} />);

        expect(await screen.findByText(/Approved by Ana \(admin\)\. Nimbus.*Send an email to Ana/))
            .toBeTruthy();
        fireEvent.change(screen.getByLabelText('Show the outcome'), { target: { value: 'blocked' } });

        await waitFor(() => {
            expect(fetchStub)
                .toHaveBeenCalledWith('/api/action-log?decision=blocked', {});
        });
    });

    it('says so when the log cannot load', async () => {
        stubLog({ error: 'no' }, 500);
        render(<ActionLogPanel bots={BOTS} onClose={vi.fn()} />);

        expect(await screen.findByRole('alert'))
            .toBeTruthy();
    });
});
