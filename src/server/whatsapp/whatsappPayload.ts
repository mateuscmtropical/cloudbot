import { isWhatsAppPhoneNumberId } from './whatsappSecrets.ts';

interface WhatsAppTextMessage {
    kind: 'text';
    phoneNumberId: string;
    messageId: string;
    from: string;
    text: string;
}

interface WhatsAppUnsupportedMessage {
    kind: 'unsupported';
    phoneNumberId: string;
    messageId: string;
    from: string;
}

type WhatsAppInboundMessage = WhatsAppTextMessage | WhatsAppUnsupportedMessage;

interface ParsedWhatsAppPayload {
    // Every phone number id in the payload, also when the call holds only statuses.
    phoneNumberIds: string[];
    messages: WhatsAppInboundMessage[];
}

const WA_ID_PATTERN = /^\d{8,15}$/;
const MAX_MESSAGE_ID_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];

    return typeof value === 'string' ? value : undefined;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
    const value = record[key];

    return Array.isArray(value) ? value : [];
}

function readMessageId(message: Record<string, unknown>): string | undefined {
    const value = readString(message, 'id')
        ?.trim();

    return value === undefined || value === '' || value.length > MAX_MESSAGE_ID_LENGTH ? undefined : value;
}

function readFrom(message: Record<string, unknown>): string | undefined {
    const value = readString(message, 'from')
        ?.trim();

    return value === undefined || !WA_ID_PATTERN.test(value) ? undefined : value;
}

function readText(message: Record<string, unknown>): string | undefined {
    if (readString(message, 'type') !== 'text') {
        return undefined;
    }

    const text = message.text;

    if (!isRecord(text)) {
        return undefined;
    }

    const body = readString(text, 'body');

    return body === undefined || body === '' ? undefined : body;
}

function parseMessage(phoneNumberId: string, rawMessage: unknown): WhatsAppInboundMessage | undefined {
    if (!isRecord(rawMessage)) {
        return undefined;
    }

    const messageId = readMessageId(rawMessage);
    const from = readFrom(rawMessage);

    if (messageId === undefined || from === undefined) {
        return undefined;
    }

    const messageType = readString(rawMessage, 'type');

    if (messageType === undefined || messageType === '') {
        return undefined;
    }

    if (messageType !== 'text') {
        return { kind: 'unsupported', phoneNumberId, messageId, from };
    }

    const text = readText(rawMessage);

    return text === undefined ? undefined : { kind: 'text', phoneNumberId, messageId, from, text };
}

function readPhoneNumberId(value: Record<string, unknown>): string | undefined {
    const metadata = value.metadata;

    if (!isRecord(metadata)) {
        return undefined;
    }

    const phoneNumberId = readString(metadata, 'phone_number_id')
        ?.trim();

    return phoneNumberId === undefined || !isWhatsAppPhoneNumberId(phoneNumberId) ? undefined : phoneNumberId;
}

function parseChange(change: unknown, phoneNumberIds: Set<string>, messages: WhatsAppInboundMessage[]): void {
    if (!isRecord(change) || change.field !== 'messages') {
        return;
    }

    const value = change.value;

    if (!isRecord(value)) {
        return;
    }

    const phoneNumberId = readPhoneNumberId(value);

    if (phoneNumberId === undefined) {
        return;
    }

    phoneNumberIds.add(phoneNumberId);

    readArray(value, 'messages')
        .forEach((rawMessage) => {
            const message = parseMessage(phoneNumberId, rawMessage);

            if (message !== undefined) {
                messages.push(message);
            }
        });
}

function parseEntry(entry: unknown, phoneNumberIds: Set<string>, messages: WhatsAppInboundMessage[]): void {
    if (!isRecord(entry)) {
        return;
    }

    readArray(entry, 'changes')
        .forEach((change) => {
            parseChange(change, phoneNumberIds, messages);
        });
}

// Reads only the parts of Meta's webhook body CloudBot uses. Unknown fields, statuses and malformed entries are
// ignored. A message of any type other than text becomes an unsupported message, so the chat can say so.
function parseWhatsAppPayload(payload: unknown): ParsedWhatsAppPayload {
    if (!isRecord(payload) || payload.object !== 'whatsapp_business_account') {
        return { phoneNumberIds: [], messages: [] };
    }

    const phoneNumberIds = new Set<string>();
    const messages: WhatsAppInboundMessage[] = [];

    readArray(payload, 'entry')
        .forEach((entry) => {
            parseEntry(entry, phoneNumberIds, messages);
        });

    return { phoneNumberIds: [...phoneNumberIds], messages };
}

export { MAX_MESSAGE_ID_LENGTH, parseWhatsAppPayload };
export type { ParsedWhatsAppPayload, WhatsAppInboundMessage, WhatsAppTextMessage, WhatsAppUnsupportedMessage };
