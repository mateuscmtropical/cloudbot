// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelsPanel } from './ModelsPanel.tsx';

interface FetchCall {
    url: string;
    method: string;
    body: unknown;
}

const SAVED_CHOICES = { chat: 'haiku', routines: null, review: null, browsing: null, documents: null };
const ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

// Answers the GET with the saved choices and the PUT with the given status.
function stubModelsApi(savedChoices: Record<string, unknown>, putStatus = 200, putBody: unknown = savedChoices): FetchCall[] {
    const calls: FetchCall[] = [];

    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

        calls.push({ url: input, method, body });

        if (method === 'GET') {
            return Promise.resolve(Response.json({ ...savedChoices, aliases: ALIASES }));
        }

        return Promise.resolve(Response.json(putBody, { status: putStatus }));
    });

    return calls;
}

describe('ModelsPanel', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('shows the saved choice of each kind of work once loaded', async () => {
        stubModelsApi(SAVED_CHOICES);

        render(<ModelsPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByLabelText('Chat'))
            .toHaveProperty('value', 'haiku');
        expect(screen.getByLabelText('Browsing helper'))
            .toHaveProperty('value', '');
    });

    it('changes one choice and saves all five with one request', async () => {
        const calls = stubModelsApi(SAVED_CHOICES);

        render(<ModelsPanel botId="bot 1" botName="Ana" onClose={vi.fn()} />);
        await screen.findByLabelText('Chat');

        fireEvent.change(screen.getByLabelText('Browsing helper'), { target: { value: 'sonnet' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save models' }));

        expect(await screen.findByRole('status'))
            .toHaveProperty('textContent', 'Saved.');

        expect(calls.find(call => call.method === 'PUT'))
            .toEqual({
                url: '/api/bots/bot%201/models',
                method: 'PUT',
                body: { chat: 'haiku', routines: null, review: null, browsing: 'sonnet', documents: null },
            });
    });

    it('shows the server error text when a save is refused', async () => {
        stubModelsApi(SAVED_CHOICES, 400, { error: 'The browsing model must be null, an alias such as haiku or sonnet, or a full model id that starts with claude-.' });

        render(<ModelsPanel botId="bot" botName="Ana" onClose={vi.fn()} />);
        await screen.findByLabelText('Chat');

        fireEvent.click(screen.getByRole('button', { name: 'Save models' }));

        expect(await screen.findByRole('alert'))
            .toHaveProperty('textContent', expect.stringContaining('The browsing model must be null'));
        expect(screen.queryByRole('status'))
            .toBeNull();
    });

    it('keeps a stored full model id as its own option so saving does not drop it', async () => {
        const calls = stubModelsApi({ ...SAVED_CHOICES, review: 'claude-sonnet-4-5' }, 200, { ...SAVED_CHOICES, review: 'claude-sonnet-4-5' });

        render(<ModelsPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByLabelText('Review agent'))
            .toHaveProperty('value', 'claude-sonnet-4-5');

        fireEvent.click(screen.getByRole('button', { name: 'Save models' }));

        await waitFor(() => {
            expect(calls.find(call => call.method === 'PUT'))
                .toBeDefined();
        });
        expect(calls.find(call => call.method === 'PUT')?.body)
            .toMatchObject({ review: 'claude-sonnet-4-5' });
    });
});
