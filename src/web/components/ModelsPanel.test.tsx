// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TurnLimits } from '../../shared/limitTypes.ts';
import { ModelsPanel } from './ModelsPanel.tsx';

interface FetchCall {
    url: string;
    method: string;
    body: unknown;
}

const SAVED_CHOICES = {
    chat: 'haiku',
    routines: null,
    review: null,
    browsing: null,
    documents: null,
    chatEffort: null,
    routinesEffort: null,
    reviewEffort: null,
    browsingEffort: null,
    documentsEffort: null,
};
const ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_LIMITS: TurnLimits = {
    chat: { minutes: null, usd: null, steps: null },
    routines: { minutes: null, usd: null, steps: null },
};
const LIMIT_BOUNDS = {
    minutes: { min: 1, max: 1440, isWhole: true },
    usd: { min: 0.01, max: 1000, isWhole: false },
    steps: { min: 1, max: 1000, isWhole: true },
};

// Answers the models GET and PUT with the saved choices, and the limits GET and PUT with the saved limits.
function stubModelsApi(savedChoices: Record<string, unknown>, putStatus = 200, putBody: unknown = savedChoices, savedLimits: TurnLimits = NO_LIMITS): FetchCall[] {
    const calls: FetchCall[] = [];

    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

        calls.push({ url: input, method, body });

        if (input.endsWith('/limits')) {
            return Promise.resolve(method === 'GET' ? Response.json({ ...savedLimits, bounds: LIMIT_BOUNDS }) : Response.json(body));
        }

        if (method === 'GET') {
            return Promise.resolve(Response.json({ ...savedChoices, aliases: ALIASES, effortLevels: EFFORT_LEVELS }));
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

        expect(calls.find(call => call.method === 'PUT' && call.url.endsWith('/models')))
            .toEqual({
                url: '/api/bots/bot%201/models',
                method: 'PUT',
                body: { ...SAVED_CHOICES, browsing: 'sonnet' },
            });
    });

    it('shows an effort select next to each model select, set to Default when none is chosen', async () => {
        stubModelsApi(SAVED_CHOICES);

        render(<ModelsPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByLabelText('Chat effort'))
            .toHaveProperty('value', '');
        expect(screen.getByLabelText('Browsing helper effort'))
            .toHaveProperty('value', '');
        expect(screen.getByLabelText('Review agent effort'))
            .toHaveProperty('value', '');
    });

    it('offers the effort levels the server sends, plus Default', async () => {
        stubModelsApi(SAVED_CHOICES);

        render(<ModelsPanel botId="bot" botName="Ana" onClose={vi.fn()} />);
        const select = await screen.findByLabelText('Routines effort');
        const options = [...select.querySelectorAll('option')].map(option => option.value);

        expect(options)
            .toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    });

    it('saves a changed effort with the models in one request', async () => {
        const calls = stubModelsApi(SAVED_CHOICES);

        render(<ModelsPanel botId="bot" botName="Ana" onClose={vi.fn()} />);
        await screen.findByLabelText('Chat effort');

        fireEvent.change(screen.getByLabelText('Chat effort'), { target: { value: 'max' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save models' }));

        await waitFor(() => {
            expect(calls.find(call => call.method === 'PUT' && call.url.endsWith('/models')))
                .toBeDefined();
        });
        expect(calls.find(call => call.method === 'PUT' && call.url.endsWith('/models'))?.body)
            .toMatchObject({ chat: 'haiku', chatEffort: 'max', browsingEffort: null });
    });

    it('clears an effort back to Default before saving', async () => {
        const calls = stubModelsApi({ ...SAVED_CHOICES, reviewEffort: 'low' });

        render(<ModelsPanel botId="bot" botName="Ana" onClose={vi.fn()} />);
        await screen.findByLabelText('Review agent effort');

        fireEvent.change(screen.getByLabelText('Review agent effort'), { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save models' }));

        await waitFor(() => {
            expect(calls.find(call => call.method === 'PUT' && call.url.endsWith('/models')))
                .toBeDefined();
        });
        expect(calls.find(call => call.method === 'PUT' && call.url.endsWith('/models'))?.body)
            .toMatchObject({ reviewEffort: null });
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
            expect(calls.find(call => call.method === 'PUT' && call.url.endsWith('/models')))
                .toBeDefined();
        });
        expect(calls.find(call => call.method === 'PUT' && call.url.endsWith('/models'))?.body)
            .toMatchObject({ review: 'claude-sonnet-4-5' });
    });

    it('shows the saved limits of each kind of turn once loaded', async () => {
        stubModelsApi(SAVED_CHOICES, 200, SAVED_CHOICES, {
            chat: { minutes: 15, usd: null, steps: 30 },
            routines: { minutes: null, usd: 0.75, steps: null },
        });

        render(<ModelsPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByLabelText('Chat turns: Time (minutes)'))
            .toHaveProperty('value', '15');
        expect(screen.getByLabelText('Chat turns: Steps'))
            .toHaveProperty('value', '30');
        expect(screen.getByLabelText('Turns from routines, webhooks and watches: Spending (USD, estimate)'))
            .toHaveProperty('value', '0.75');
        expect(screen.getByLabelText('Chat turns: Spending (USD, estimate)'))
            .toHaveProperty('value', '');
    });

    it('saves the limits with one PUT, and an emptied box saves no limit', async () => {
        const calls = stubModelsApi(SAVED_CHOICES, 200, SAVED_CHOICES, {
            chat: { minutes: 15, usd: null, steps: null },
            routines: { minutes: null, usd: null, steps: null },
        });

        render(<ModelsPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        fireEvent.change(await screen.findByLabelText('Chat turns: Time (minutes)'), { target: { value: '' } });
        fireEvent.change(screen.getByLabelText('Turns from routines, webhooks and watches: Steps'), { target: { value: '8' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));

        expect(await screen.findByText('Limits saved.'))
            .toBeDefined();
        expect(calls.find(call => call.method === 'PUT' && call.url.endsWith('/limits'))?.body)
            .toEqual({
                chat: { minutes: null, usd: null, steps: null },
                routines: { minutes: null, usd: null, steps: 8 },
            });
    });

    it('says the spending is an estimate and a subscription is not billed by it', async () => {
        stubModelsApi(SAVED_CHOICES);

        render(<ModelsPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByText(/a subscription is not billed by it/))
            .toBeDefined();
    });
});
