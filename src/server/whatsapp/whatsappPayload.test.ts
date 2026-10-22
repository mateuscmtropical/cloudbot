import { describe, expect, it } from 'vitest';

import { parseWhatsAppPayload } from './whatsappPayload.ts';

const PHONE_NUMBER_ID = '109876543210987';
const FROM = '15551234567';

interface PayloadMessage {
    id: string;
    from?: string;
    type: string;
    text?: { body: string };
}

function buildPayload(messages: PayloadMessage[], phoneNumberId = PHONE_NUMBER_ID): unknown {
    return {
        object: 'whatsapp_business_account',
        entry: [
            {
                id: 'business-account',
                changes: [
                    {
                        field: 'messages',
                        value: {
                            messaging_product: 'whatsapp',
                            metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
                            messages,
                        },
                    },
                ],
            },
        ],
    };
}

describe('parseWhatsAppPayload', () => {
    it('reads a text message with its phone number id, message id, sender and body', () => {
        const parsed = parseWhatsAppPayload(buildPayload([{ id: 'wamid.one', from: FROM, type: 'text', text: { body: 'Build the report' } }]));

        expect(parsed.phoneNumberIds)
            .toEqual([PHONE_NUMBER_ID]);
        expect(parsed.messages)
            .toEqual([{ kind: 'text', phoneNumberId: PHONE_NUMBER_ID, messageId: 'wamid.one', from: FROM, text: 'Build the report' }]);
    });

    it('marks every other message type as unsupported', () => {
        const parsed = parseWhatsAppPayload(buildPayload([
            { id: 'wamid.image', from: FROM, type: 'image' },
            { id: 'wamid.audio', from: FROM, type: 'audio' },
        ]));

        expect(parsed.messages)
            .toEqual([
                { kind: 'unsupported', phoneNumberId: PHONE_NUMBER_ID, messageId: 'wamid.image', from: FROM },
                { kind: 'unsupported', phoneNumberId: PHONE_NUMBER_ID, messageId: 'wamid.audio', from: FROM },
            ]);
    });

    it('reads the phone number id from a status call and returns no messages', () => {
        const payload = {
            object: 'whatsapp_business_account',
            entry: [{
                changes: [{
                    field: 'messages',
                    value: {
                        metadata: { phone_number_id: PHONE_NUMBER_ID },
                        statuses: [{ id: 'wamid.one', status: 'delivered' }],
                    },
                }],
            }],
        };

        expect(parseWhatsAppPayload(payload))
            .toEqual({ phoneNumberIds: [PHONE_NUMBER_ID], messages: [] });
    });

    it('keeps each phone number id once and ignores other fields and entries', () => {
        const payload = {
            object: 'whatsapp_business_account',
            entry: [
                {
                    changes: [
                        { field: 'messages', value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, messages: [] } },
                        { field: 'message_template_status_update', value: { metadata: { phone_number_id: '999' } } },
                    ],
                },
                {
                    changes: [
                        { field: 'messages', value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, messages: [] } },
                        { field: 'messages', value: { metadata: { phone_number_id: '555555555' }, messages: [] } },
                    ],
                },
                'not an entry',
            ],
        };

        expect(parseWhatsAppPayload(payload).phoneNumberIds)
            .toEqual([PHONE_NUMBER_ID, '555555555']);
    });

    it('ignores a body that is not a WhatsApp payload', () => {
        expect(parseWhatsAppPayload(undefined))
            .toEqual({ phoneNumberIds: [], messages: [] });
        expect(parseWhatsAppPayload({ object: 'something_else', entry: [] }))
            .toEqual({ phoneNumberIds: [], messages: [] });
        expect(parseWhatsAppPayload([]))
            .toEqual({ phoneNumberIds: [], messages: [] });
    });

    it('skips malformed messages and keeps whitespace text as text', () => {
        const parsed = parseWhatsAppPayload(buildPayload([
            { id: '', from: FROM, type: 'text', text: { body: 'empty id' } },
            { id: 'wamid.no-from', type: 'text', text: { body: 'no sender' } },
            { id: 'wamid.short', from: '123', type: 'text', text: { body: 'short' } },
            { id: 'wamid.blank', from: FROM, type: 'text', text: { body: '   ' } },
            { id: 'wamid.no-body', from: FROM, type: 'text' },
            { id: 'wamid.good', from: FROM, type: 'text', text: { body: 'works' } },
        ]));

        expect(parsed.messages)
            .toEqual([
                { kind: 'text', phoneNumberId: PHONE_NUMBER_ID, messageId: 'wamid.blank', from: FROM, text: '   ' },
                { kind: 'text', phoneNumberId: PHONE_NUMBER_ID, messageId: 'wamid.good', from: FROM, text: 'works' },
            ]);
    });

    it('ignores a change with no metadata phone number id', () => {
        const payload = {
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.one', from: FROM, type: 'text', text: { body: 'hi' } }] } }] }],
        };

        expect(parseWhatsAppPayload(payload))
            .toEqual({ phoneNumberIds: [], messages: [] });
    });
});
