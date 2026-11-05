// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebhooksPanel } from './WebhooksPanel.tsx';

const BOT = { id: 'bot-1', name: 'Nimbus' };
const WEBHOOK = {
    id: 'hook-1',
    name: 'deploys',
    createdAt: 1,
    refusals: [],
    rules: [{ provider: 'github', instruction: 'Run the tests' }],
    calls: [{ time: Date.parse('2026-11-05T10:00:00.000Z'), provider: 'github', event: 'push', address: '203.0.113.9', userAgent: 'GitHub-Hookshot/1' }],
    signedProviders: [],
};

function stubFetch(handler: (path: string, init: RequestInit | undefined) => Response): ReturnType<typeof vi.fn> {
    const fetchStub = vi.fn((path: string, init?: RequestInit) => Promise.resolve(handler(path, init)));

    vi.stubGlobal('fetch', fetchStub);

    return fetchStub;
}

describe('WebhooksPanel', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('shows the rules and who called', async () => {
        stubFetch(() => Response.json([WEBHOOK]));
        render(<WebhooksPanel bot={BOT} onClose={vi.fn()} />);

        expect(await screen.findByText('Run the tests'))
            .toBeTruthy();
        expect(screen.getByText('github: push'))
            .toBeTruthy();
        expect(screen.getByText(/203\.0\.113\.9, GitHub-Hookshot\/1/))
            .toBeTruthy();
    });

    it('makes a webhook and shows its URL once', async () => {
        const made = { ...WEBHOOK, id: 'hook-2', name: 'forms', rules: [], calls: [], url: 'https://bot.example.test/hooks/secret' };

        stubFetch((_path, init) => (init?.method === 'POST' ? Response.json(made, { status: 201 }) : Response.json([])));
        render(<WebhooksPanel bot={BOT} onClose={vi.fn()} />);
        await screen.findByText('No webhooks yet.');
        fireEvent.change(screen.getByLabelText('New webhook name'), { target: { value: 'forms' } });
        fireEvent.submit(screen.getByRole('form', { name: 'Make a webhook' }));

        const urlField = await screen.findByLabelText('Webhook URL');

        expect((urlField as HTMLInputElement).value)
            .toBe(made.url);
        fireEvent.click(screen.getByRole('button', { name: 'Hide URL' }));
        expect(screen.queryByLabelText('Webhook URL'))
            .toBeNull();
    });

    it('saves a rule for a provider in lower case', async () => {
        const fetchStub = stubFetch((_path, init) => (init?.method === 'PUT' ? Response.json({ ...WEBHOOK, rules: [{ provider: 'stripe', instruction: 'Note the payment' }] }) : Response.json([WEBHOOK])));

        render(<WebhooksPanel bot={BOT} onClose={vi.fn()} />);
        await screen.findByText('Run the tests');
        fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'Stripe' } });
        fireEvent.change(screen.getByLabelText('What the bot should do'), { target: { value: 'Note the payment' } });
        fireEvent.submit(screen.getByRole('form', { name: 'Add a rule to deploys' }));

        expect(await screen.findByText('Note the payment'))
            .toBeTruthy();
        expect(fetchStub)
            .toHaveBeenCalledWith('/api/bots/bot-1/webhooks/hook-1/rules/stripe', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ instruction: 'Note the payment' }) }));
    });

    it('saves a signing secret and lists only the provider', async () => {
        const fetchStub = stubFetch((_path, init) => (init?.method === 'PUT' ? Response.json({ ...WEBHOOK, signedProviders: ['stripe'] }) : Response.json([WEBHOOK])));

        render(<WebhooksPanel bot={BOT} onClose={vi.fn()} />);
        await screen.findByText('Run the tests');
        fireEvent.change(screen.getByLabelText('Signed provider'), { target: { value: 'stripe' } });
        fireEvent.change(screen.getByLabelText('Signing secret'), { target: { value: 'whsec_abc' } });
        fireEvent.submit(screen.getByRole('form', { name: 'Add a signing secret to deploys' }));

        expect(await screen.findByText('Calls that claim this provider need its signature.'))
            .toBeTruthy();
        expect(fetchStub)
            .toHaveBeenCalledWith('/api/bots/bot-1/webhooks/hook-1/secrets/stripe', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ secret: 'whsec_abc' }) }));
        expect(screen.getByLabelText<HTMLInputElement>('Signing secret').value)
            .toBe('');
    });

    it('removes a rule by saving an empty instruction, and shows a refusal', async () => {
        const fetchStub = stubFetch((_path, init) => (init?.method === 'PUT' ? Response.json({ error: 'No rule for you.' }, { status: 400 }) : Response.json([WEBHOOK])));

        render(<WebhooksPanel bot={BOT} onClose={vi.fn()} />);
        await screen.findByText('Run the tests');
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

        await waitFor(() => {
            expect(fetchStub)
                .toHaveBeenCalledWith('/api/bots/bot-1/webhooks/hook-1/rules/github', expect.objectContaining({ body: JSON.stringify({ instruction: '' }) }));
        });
        expect(await screen.findByRole('alert'))
            .toBeTruthy();
    });
});
