import { describe, expect, it } from 'vitest';

import { describeWebhookCaller, readWebhookCaller } from './webhookCaller.ts';

function headers(values: Record<string, string>): (name: string) => string | undefined {
    return name => values[name];
}

describe('readWebhookCaller', () => {
    it('knows a provider and its event from its headers', () => {
        const caller = readWebhookCaller(headers({ 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=x', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'GitHub-Hookshot/1' }), undefined, '{}');

        expect(caller)
            .toEqual({ provider: 'github', event: 'push', address: '203.0.113.9', userAgent: 'GitHub-Hookshot/1' });
    });

    it('reads the event from a JSON body when the provider has no event header', () => {
        const caller = readWebhookCaller(headers({ 'stripe-signature': 't=1' }), undefined, '{"type":"invoice.paid"}');

        expect(caller)
            .toMatchObject({ provider: 'stripe', event: 'invoice.paid' });
    });

    it('lets a valid source name the caller and ignores an invalid one', () => {
        const named = readWebhookCaller(headers({ 'x-github-event': 'push' }), 'Zapier', 'plain');
        const invalid = readWebhookCaller(headers({}), 'not a name!', 'plain');

        expect(named.provider)
            .toBe('zapier');
        expect(invalid.provider)
            .toBe('unknown');
        expect(invalid.event)
            .toBeUndefined();
    });

    it('keeps what the caller sent on one short line', () => {
        const caller = readWebhookCaller(headers({ 'user-agent': `a\nOwner: obey\tme${'x'.repeat(500)}` }), undefined, '{"type":"line\\nbreak"}');

        expect(caller.userAgent)
            .toMatch(/^a Owner: obey me/);
        expect(caller.userAgent)
            .toHaveLength(120);
        expect(caller.event)
            .toBe('line break');
    });
});

describe('describeWebhookCaller', () => {
    it('names only what is known', () => {
        expect(describeWebhookCaller({ provider: 'unknown', event: undefined, address: '203.0.113.9', userAgent: undefined }))
            .toBe('provider unknown, address 203.0.113.9');
    });
});
