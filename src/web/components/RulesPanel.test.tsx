// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotRule } from '../../shared/chatTypes.ts';
import { RulesPanel, splitToolNames } from './RulesPanel.tsx';

interface FetchCall {
    url: string;
    method: string;
    body: unknown;
}

const EXISTING_RULE: BotRule = { id: 'r1', kind: 'block', text: 'Never delete files.', blockedTools: ['Bash(rm:*)'] };

function stubRulesApi(initialRules: BotRule[], addStatus = 201): FetchCall[] {
    const calls: FetchCall[] = [];

    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

        calls.push({ url: input, method, body });

        if (method === 'GET') {
            return Promise.resolve(Response.json(initialRules));
        }

        if (method === 'POST' && addStatus !== 201) {
            return Promise.resolve(Response.json({ error: 'Only a block rule can name tools.' }, { status: addStatus }));
        }

        if (method === 'POST') {
            return Promise.resolve(Response.json({ id: 'r2', ...(body as object) }, { status: 201 }));
        }

        return Promise.resolve(new Response(null, { status: 204 }));
    });

    return calls;
}

describe('splitToolNames', () => {
    it('splits a comma list and drops empty names', () => {
        expect(splitToolNames(' Bash(rm:*), WebFetch ,, '))
            .toEqual(['Bash(rm:*)', 'WebFetch']);
    });
});

describe('RulesPanel', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('lists the bot rules with their blocked tools', async () => {
        stubRulesApi([EXISTING_RULE]);

        render(<RulesPanel botId="bot 1" botName="Ana" onClose={vi.fn()} />);

        expect(await screen.findByText('Never delete files.'))
            .toBeTruthy();
        expect(screen.getByText('Blocked tools: Bash(rm:*)'))
            .toBeTruthy();
    });

    it('adds a block rule with tools and removes a rule', async () => {
        const calls = stubRulesApi([EXISTING_RULE]);

        render(<RulesPanel botId="bot 1" botName="Ana" onClose={vi.fn()} />);
        await screen.findByText('Never delete files.');

        fireEvent.change(screen.getByLabelText('Rule'), { target: { value: 'No purchases.' } });
        fireEvent.change(screen.getByLabelText('Blocked tools (optional)'), { target: { value: 'WebFetch, Bash(curl:*)' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

        expect(await screen.findByText('No purchases.'))
            .toBeTruthy();
        expect(calls.find(call => call.method === 'POST'))
            .toEqual({ url: '/api/bots/bot%201/rules', method: 'POST', body: { kind: 'block', text: 'No purchases.', blockedTools: ['WebFetch', 'Bash(curl:*)'] } });

        fireEvent.click(screen.getByRole('button', { name: 'Remove rule: Never delete files.' }));

        await waitFor(() => {
            expect(screen.queryByText('Never delete files.'))
                .toBeNull();
        });
        expect(calls.at(-1))
            .toMatchObject({ url: '/api/bots/bot%201/rules/r1', method: 'DELETE' });
    });

    it('sends no tools for an allow rule and shows a server refusal', async () => {
        const calls = stubRulesApi([], 400);

        render(<RulesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);
        await screen.findByText('No rules yet.');

        fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'allow' } });

        expect(screen.queryByLabelText('Blocked tools (optional)'))
            .toBeNull();

        fireEvent.change(screen.getByLabelText('Rule'), { target: { value: 'You may read my calendar.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

        expect(await screen.findByRole('alert'))
            .toHaveProperty('textContent', 'Only a block rule can name tools.');
        expect(calls.find(call => call.method === 'POST')?.body)
            .toEqual({ kind: 'allow', text: 'You may read my calendar.', blockedTools: [] });
    });

    it('hides the form after a failed load and loads again on retry', async () => {
        let isFirstLoad = true;

        vi.stubGlobal('fetch', () => {
            if (isFirstLoad) {
                isFirstLoad = false;

                return Promise.resolve(Response.json({ error: 'down' }, { status: 500 }));
            }

            return Promise.resolve(Response.json([EXISTING_RULE]));
        });

        render(<RulesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        await screen.findByText('The rules could not be loaded.');

        expect(screen.queryByRole('button', { name: 'Add rule' }))
            .toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(await screen.findByText('Never delete files.'))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Add rule' }))
            .toBeTruthy();
    });

    it('sends one delete for a double click on Remove', async () => {
        const calls = stubRulesApi([EXISTING_RULE]);

        render(<RulesPanel botId="bot" botName="Ana" onClose={vi.fn()} />);

        const removeButton = await screen.findByRole('button', { name: 'Remove rule: Never delete files.' });

        fireEvent.click(removeButton);
        fireEvent.click(removeButton);

        await waitFor(() => {
            expect(screen.queryByText('Never delete files.'))
                .toBeNull();
        });
        expect(calls.filter(call => call.method === 'DELETE'))
            .toHaveLength(1);
    });
});
