import { describe, expect, it, vi } from 'vitest';

import type { WhatsAppConnectOutcome } from './WhatsAppSetup.ts';
import { WHATSAPP_CONNECT_TOOL_FULL_NAME, WHATSAPP_DISCONNECT_TOOL_FULL_NAME, WHATSAPP_TOOL_FULL_NAMES, createWhatsAppTools } from './createWhatsAppTools.ts';
import type { WhatsAppConnector, WhatsAppToolResult } from './createWhatsAppTools.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<WhatsAppToolResult>;

const BOT_ID = 'bot-one';

function createFakeConnector(outcome: WhatsAppConnectOutcome, disconnectResult = true): WhatsAppConnector {
    return {
        connect: vi.fn(() => Promise.resolve(outcome)),
        disconnect: vi.fn(() => Promise.resolve(disconnectResult)),
    };
}

function findHandler(connector: WhatsAppConnector, name: string): ToolHandler {
    const tools = createWhatsAppTools(connector, BOT_ID) as unknown as { name: string; handler: unknown }[];
    const found = tools.find(candidate => candidate.name === name);

    if (found === undefined) {
        throw new Error(`No tool ${name}`);
    }

    return found.handler as ToolHandler;
}

describe('createWhatsAppTools', () => {
    it('offers connect and disconnect with the expected full names', () => {
        const names = (createWhatsAppTools(createFakeConnector({ status: 'invalid-phone-number-id' }), BOT_ID) as unknown as { name: string }[])
            .map(candidate => candidate.name);

        expect(names)
            .toEqual(['whatsapp_connect', 'whatsapp_disconnect']);
        expect(WHATSAPP_TOOL_FULL_NAMES)
            .toEqual([WHATSAPP_CONNECT_TOOL_FULL_NAME, WHATSAPP_DISCONNECT_TOOL_FULL_NAME]);
    });

    it('asks the owner to fill the app secret form and call again', async () => {
        const handler = findHandler(createFakeConnector({ status: 'form', secretName: 'WHATSAPP_APP_SECRET', isReplacement: false }), 'whatsapp_connect');

        const result = await handler({ phoneNumberId: '123456789' }, {});

        expect(result.isError)
            .toBeUndefined();
        expect(result.content[0]?.text)
            .toContain('A secure form for the Meta app secret is in the chat.');
        expect(result.content[0]?.text)
            .toContain('call whatsapp_connect again');
    });

    it('says a saved secret was not valid and posts a new form', async () => {
        const handler = findHandler(createFakeConnector({ status: 'form', secretName: 'WHATSAPP_APP_SECRET', isReplacement: true }), 'whatsapp_connect');

        const result = await handler({ phoneNumberId: '123456789' }, {});

        expect(result.content[0]?.text)
            .toContain('The saved Meta app secret is not valid.');
    });

    it('returns the callback URL and the Meta steps after a link, without any secret', async () => {
        const handler = findHandler(createFakeConnector({
            status: 'linked',
            phoneNumberId: '123456789',
            callbackUrl: 'https://bot.example.test/whatsapp',
            isAlreadyLinked: false,
        }), 'whatsapp_connect');

        const result = await handler({ phoneNumberId: '123456789' }, {});
        const text = result.content[0]?.text ?? '';

        expect(text)
            .toContain('https://bot.example.test/whatsapp');
        expect(text)
            .toContain('subscribe to the messages field');
        expect(text)
            .toContain('never send a WhatsApp message');
        expect(text)
            .not.toContain('0123456789abcdef');
    });

    it('marks a non numeric phone number id as an error', async () => {
        const handler = findHandler(createFakeConnector({ status: 'invalid-phone-number-id' }), 'whatsapp_connect');

        const result = await handler({ phoneNumberId: 'not-a-number' }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toContain('numeric ID');
    });

    it('explains a number taken by another bot and a bot that is already linked', async () => {
        const taken = findHandler(createFakeConnector({ status: 'phone-taken' }), 'whatsapp_connect');
        const botLinked = findHandler(createFakeConnector({ status: 'bot-linked', phoneNumberId: '555' }), 'whatsapp_connect');

        await expect(taken({ phoneNumberId: '123' }, {}))
            .resolves.toMatchObject({ isError: true });
        const result = await botLinked({ phoneNumberId: '123' }, {});

        expect(result.content[0]?.text)
            .toContain('already connected to phone number ID 555');
    });

    it('disconnects and reports whether a connection existed', async () => {
        const connector = createFakeConnector({ status: 'invalid-phone-number-id' }, true);
        const connected = await findHandler(connector, 'whatsapp_disconnect')({}, {});
        const notConnected = await findHandler(createFakeConnector({ status: 'invalid-phone-number-id' }, false), 'whatsapp_disconnect')({}, {});

        expect(connected.content[0]?.text)
            .toBe('WhatsApp is disconnected.');
        expect(notConnected.content[0]?.text)
            .toBe('WhatsApp was not connected.');
        expect(connector.disconnect)
            .toHaveBeenCalledWith(BOT_ID);
    });

    it('turns a thrown error into a short message for the model', async () => {
        const connector: WhatsAppConnector = {
            connect: () => Promise.reject(new Error('hidden detail')),
            disconnect: () => Promise.reject(new Error('hidden detail')),
        };
        const result = await findHandler(connector, 'whatsapp_connect')({ phoneNumberId: '123' }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toBe('WhatsApp could not be set up. Try again later.');
    });
});
