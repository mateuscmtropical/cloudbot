import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SIGNED_WEBHOOK_PROVIDERS } from '../../shared/webhookTypes.ts';
import { MAX_SIGNATURE_AGE_MS, SIGNED_PROVIDERS, checkWebhookSignature } from './webhookSignature.ts';

const SECRET = 'shh-secret';
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const SECONDS = String(NOW / 1000);
const BODY = Buffer.from('{"ref":"main","name":"café"}');

function sign(data: string | Buffer, encoding: 'hex' | 'base64' = 'hex'): string {
    return createHmac('sha256', SECRET)
        .update(data)
        .digest(encoding);
}

function check(provider: string, headers: Record<string, string>, body = BODY, now = NOW): boolean {
    return checkWebhookSignature(provider, SECRET, name => headers[name], body, now);
}

describe('checkWebhookSignature', () => {
    it('checks the same providers the web app offers', () => {
        expect(SIGNED_PROVIDERS)
            .toEqual(SIGNED_WEBHOOK_PROVIDERS);
    });

    it('accepts the signature of each provider and refuses a wrong one', () => {
        const stripeSigned = Buffer.concat([Buffer.from(`${SECONDS}.`), BODY]);
        const slackSigned = Buffer.concat([Buffer.from(`v0:${SECONDS}:`), BODY]);
        const good: [string, Record<string, string>][] = [
            ['github', { 'x-hub-signature-256': `sha256=${sign(BODY)}` }],
            ['gitlab', { 'x-gitlab-token': SECRET }],
            ['shopify', { 'x-shopify-hmac-sha256': sign(BODY, 'base64') }],
            ['linear', { 'linear-signature': sign(BODY) }],
            ['stripe', { 'stripe-signature': `t=${SECONDS},v1=wrong,v1=${sign(stripeSigned)}` }],
            ['slack', { 'x-slack-request-timestamp': SECONDS, 'x-slack-signature': `v0=${sign(slackSigned)}` }],
        ];
        const results = good.map(([provider, headers]) => check(provider, headers));
        const tampered = good.map(([provider, headers]) => check(provider, headers, Buffer.from('{"ref":"evil"}')));

        expect(results)
            .toEqual([true, true, true, true, true, true]);
        expect(tampered)
            .toEqual([false, true, false, false, false, false]);
    });

    it('refuses a missing header, an unknown provider and a wrong GitLab token', () => {
        expect(check('github', {}))
            .toBe(false);
        expect(check('zapier', { 'x-hub-signature-256': `sha256=${sign(BODY)}` }))
            .toBe(false);
        expect(check('gitlab', { 'x-gitlab-token': 'shh-secreT' }))
            .toBe(false);
    });

    it('refuses an old Stripe or Slack signature, even a right one', () => {
        const later = NOW + MAX_SIGNATURE_AGE_MS + 1000;
        const stripeSigned = Buffer.concat([Buffer.from(`${SECONDS}.`), BODY]);
        const slackSigned = Buffer.concat([Buffer.from(`v0:${SECONDS}:`), BODY]);

        expect(check('stripe', { 'stripe-signature': `t=${SECONDS},v1=${sign(stripeSigned)}` }, BODY, later))
            .toBe(false);
        expect(check('slack', { 'x-slack-request-timestamp': SECONDS, 'x-slack-signature': `v0=${sign(slackSigned)}` }, BODY, later))
            .toBe(false);
    });
});
