import { describe, expect, it } from 'vitest';

import {
    MAX_VERIFY_TOKEN_LENGTH,
    WHATSAPP_API_SITE,
    WHATSAPP_APP_SECRET_NAME,
    WHATSAPP_OWNER_NUMBER_NAME,
    WHATSAPP_VERIFY_TOKEN_NAME,
    isWhatsAppAppSecret,
    isWhatsAppPhoneNumberId,
    isWhatsAppVerifyToken,
    normalizeWhatsAppOwnerNumber,
    readWhatsAppAppSecret,
    readWhatsAppOwnerNumber,
    readWhatsAppVerifyToken,
} from './whatsappSecrets.ts';
import type { WhatsAppSecretReader } from './whatsappSecrets.ts';

class FakeSecrets implements WhatsAppSecretReader {
    private readonly values = new Map<string, string>();

    read(botId: string, name: string): { value: string } | undefined {
        const value = this.values.get(`${botId}:${name}`);

        return value === undefined ? undefined : { value };
    }

    save(botId: string, name: string, value: string): void {
        this.values.set(`${botId}:${name}`, value);
    }
}

describe('WhatsApp secret readers', () => {
    it('accepts numeric Meta phone number ids and 32 character app secrets', () => {
        expect(isWhatsAppPhoneNumberId('123456789'))
            .toBe(true);
        expect(isWhatsAppPhoneNumberId('123x'))
            .toBe(false);
        expect(isWhatsAppAppSecret('0123456789abcdef0123456789ABCDEF'))
            .toBe(true);
        expect(isWhatsAppAppSecret('not-an-app-secret'))
            .toBe(false);
    });

    it('accepts non-empty verify tokens within the size limit', () => {
        expect(isWhatsAppVerifyToken('token'))
            .toBe(true);
        expect(isWhatsAppVerifyToken(''))
            .toBe(false);
        expect(isWhatsAppVerifyToken('x'.repeat(MAX_VERIFY_TOKEN_LENGTH + 1)))
            .toBe(false);
    });

    it('normalizes an international owner number to the digits Meta sends', () => {
        expect(normalizeWhatsAppOwnerNumber('+1 (555) 123-4567'))
            .toBe('15551234567');
        expect(normalizeWhatsAppOwnerNumber('1234567'))
            .toBeUndefined();
        expect(normalizeWhatsAppOwnerNumber('1555abc4567'))
            .toBeUndefined();
    });

    it('reads the app secret, verify token and owner number from the bot vault interface', () => {
        const secrets = new FakeSecrets();

        secrets.save('bot-1', WHATSAPP_APP_SECRET_NAME, '  0123456789abcdef0123456789abcdef  ');
        secrets.save('bot-1', WHATSAPP_VERIFY_TOKEN_NAME, '  verify-me  ');
        secrets.save('bot-1', WHATSAPP_OWNER_NUMBER_NAME, '+1 (555) 123-4567');

        expect(readWhatsAppAppSecret(secrets, 'bot-1'))
            .toBe('0123456789abcdef0123456789abcdef');
        expect(readWhatsAppVerifyToken(secrets, 'bot-1'))
            .toBe('verify-me');
        expect(readWhatsAppOwnerNumber(secrets, 'bot-1'))
            .toBe('15551234567');
        expect(readWhatsAppVerifyToken(secrets, 'missing-bot'))
            .toBeUndefined();
        expect(WHATSAPP_API_SITE)
            .toBe('https://graph.facebook.com');
    });
});
