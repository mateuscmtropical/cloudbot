import type { WebhookCaller } from '../../shared/webhookTypes.ts';
import { UNKNOWN_PROVIDER } from '../../shared/webhookTypes.ts';

interface ProviderSignature {
    provider: string;
    // A header only this provider sends.
    header: string;
    // The header that names the event, when the provider has one.
    eventHeader?: string;
}

const MAX_VALUE_LENGTH = 120;
const SOURCE_PATTERN = /^[a-z0-9_-]{1,40}$/;
// The first match wins. GitHub comes before Meta, because both send x-hub-signature-256.
const PROVIDER_SIGNATURES: ProviderSignature[] = [
    { provider: 'github', header: 'x-github-event', eventHeader: 'x-github-event' },
    { provider: 'gitlab', header: 'x-gitlab-event', eventHeader: 'x-gitlab-event' },
    { provider: 'bitbucket', header: 'x-event-key', eventHeader: 'x-event-key' },
    { provider: 'shopify', header: 'x-shopify-topic', eventHeader: 'x-shopify-topic' },
    { provider: 'linear', header: 'linear-signature', eventHeader: 'linear-event' },
    { provider: 'sentry', header: 'sentry-hook-resource', eventHeader: 'sentry-hook-resource' },
    { provider: 'stripe', header: 'stripe-signature' },
    { provider: 'slack', header: 'x-slack-signature' },
    { provider: 'twilio', header: 'x-twilio-signature' },
    { provider: 'discord', header: 'x-signature-ed25519' },
    { provider: 'svix', header: 'svix-id' },
    { provider: 'meta', header: 'x-hub-signature-256' },
];
const BODY_EVENT_FIELDS = ['type', 'event', 'action'];

// These values come from the caller and end up in a chat message, so each one stays short and on one line.
function cleanValue(value: string | undefined): string | undefined {
    const oneLine = (value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ');
    const trimmed = oneLine.trim();

    return trimmed === '' ? undefined : trimmed.slice(0, MAX_VALUE_LENGTH);
}

// Many services name the event in a top level field of a JSON body.
function readBodyEvent(body: string): string | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(body);
    } catch {
        return undefined;
    }

    if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const values = BODY_EVENT_FIELDS.map(field => record[field]);

    return values.find((value): value is string => typeof value === 'string');
}

// Who called, as far as the request says. Anyone with the URL can claim any of this, so it picks a rule and never proves who
// called. A service whose headers are not known can name itself with ?source= in the URL.
function readWebhookCaller(readHeader: (name: string) => string | undefined, source: string | undefined, body: string): WebhookCaller {
    const signature = PROVIDER_SIGNATURES.find(known => readHeader(known.header) !== undefined);
    const lowerSource = source?.toLowerCase();
    const namedSource = lowerSource !== undefined && SOURCE_PATTERN.test(lowerSource) ? lowerSource : undefined;
    const provider = namedSource ?? signature?.provider ?? UNKNOWN_PROVIDER;
    const headerEvent = signature?.eventHeader === undefined ? undefined : readHeader(signature.eventHeader);
    const eventText = headerEvent ?? readBodyEvent(body);
    const forwardedFor = readHeader('x-forwarded-for');
    const firstAddress = forwardedFor?.split(',')[0];
    const userAgent = readHeader('user-agent');

    return {
        provider,
        event: cleanValue(eventText),
        address: cleanValue(firstAddress),
        userAgent: cleanValue(userAgent),
    };
}

function describeWebhookCaller(caller: WebhookCaller): string {
    const parts = [
        `provider ${caller.provider}`,
        ...(caller.event === undefined ? [] : [`event ${caller.event}`]),
        ...(caller.address === undefined ? [] : [`address ${caller.address}`]),
        ...(caller.userAgent === undefined ? [] : [`user agent ${caller.userAgent}`]),
    ];

    return parts.join(', ');
}

export { describeWebhookCaller, readWebhookCaller };
