// The names the bot reads and writes in the vault. They stay the same in the setup forms and the webhook route.
const WHATSAPP_APP_SECRET_NAME = 'WHATSAPP_APP_SECRET';
const WHATSAPP_VERIFY_TOKEN_NAME = 'WHATSAPP_VERIFY_TOKEN';
const WHATSAPP_OWNER_NUMBER_NAME = 'WHATSAPP_OWNER_NUMBER';
const WHATSAPP_SECRET_NAMES = [WHATSAPP_APP_SECRET_NAME, WHATSAPP_VERIFY_TOKEN_NAME, WHATSAPP_OWNER_NUMBER_NAME] as const;

type WhatsAppSecretName = typeof WHATSAPP_SECRET_NAMES[number];

// Meta signs each call with the app secret. The secret and the verify token belong to this API site.
const WHATSAPP_API_SITE = 'https://graph.facebook.com';
const WHATSAPP_CALLBACK_PATH = '/whatsapp';

const APP_SECRET_PATTERN = /^[0-9a-f]{32}$/i;
const PHONE_NUMBER_ID_PATTERN = /^\d{1,32}$/;
const OWNER_NUMBER_PATTERN = /^\d{8,15}$/;
const MAX_VERIFY_TOKEN_LENGTH = 256;

// The part of BotSecrets the WhatsApp setup and the public route need.
interface WhatsAppSecretReader {
    read: (botId: string, name: string) => { value: string } | undefined;
}

function isWhatsAppPhoneNumberId(value: string): boolean {
    return PHONE_NUMBER_ID_PATTERN.test(value);
}

// Meta's App Secret is 32 hexadecimal characters.
function isWhatsAppAppSecret(value: string): boolean {
    return APP_SECRET_PATTERN.test(value);
}

function isWhatsAppVerifyToken(value: string): boolean {
    return value !== '' && value.length <= MAX_VERIFY_TOKEN_LENGTH;
}

// Meta sends the owner's number as digits only. The owner may type +, spaces, brackets, dots or dashes.
function normalizeWhatsAppOwnerNumber(value: string): string | undefined {
    const digits = value.trim()
        .replace(/[()\s+.-]/g, '');

    return OWNER_NUMBER_PATTERN.test(digits) ? digits : undefined;
}

function readWhatsAppAppSecret(secrets: WhatsAppSecretReader, botId: string): string | undefined {
    const value = secrets.read(botId, WHATSAPP_APP_SECRET_NAME)?.value.trim();

    return value === undefined || value === '' ? undefined : value;
}

function readWhatsAppVerifyToken(secrets: WhatsAppSecretReader, botId: string): string | undefined {
    const value = secrets.read(botId, WHATSAPP_VERIFY_TOKEN_NAME)?.value.trim();

    return value === undefined || !isWhatsAppVerifyToken(value) ? undefined : value;
}

function readWhatsAppOwnerNumber(secrets: WhatsAppSecretReader, botId: string): string | undefined {
    const value = secrets.read(botId, WHATSAPP_OWNER_NUMBER_NAME)?.value;

    return value === undefined ? undefined : normalizeWhatsAppOwnerNumber(value);
}

export {
    MAX_VERIFY_TOKEN_LENGTH,
    WHATSAPP_API_SITE,
    WHATSAPP_APP_SECRET_NAME,
    WHATSAPP_CALLBACK_PATH,
    WHATSAPP_OWNER_NUMBER_NAME,
    WHATSAPP_SECRET_NAMES,
    WHATSAPP_VERIFY_TOKEN_NAME,
    isWhatsAppAppSecret,
    isWhatsAppPhoneNumberId,
    isWhatsAppVerifyToken,
    normalizeWhatsAppOwnerNumber,
    readWhatsAppAppSecret,
    readWhatsAppOwnerNumber,
    readWhatsAppVerifyToken,
};
export type { WhatsAppSecretName, WhatsAppSecretReader };
