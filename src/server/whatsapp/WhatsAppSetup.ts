import type { WhatsAppStore } from '../store/WhatsAppStore.ts';
import {
    WHATSAPP_API_SITE,
    WHATSAPP_APP_SECRET_NAME,
    WHATSAPP_CALLBACK_PATH,
    WHATSAPP_OWNER_NUMBER_NAME,
    WHATSAPP_SECRET_NAMES,
    WHATSAPP_VERIFY_TOKEN_NAME,
    isWhatsAppAppSecret,
    isWhatsAppPhoneNumberId,
    readWhatsAppAppSecret,
    readWhatsAppOwnerNumber,
    readWhatsAppVerifyToken,
} from './whatsappSecrets.ts';
import type { WhatsAppSecretName, WhatsAppSecretReader } from './whatsappSecrets.ts';

// The part of the chat the setup posts into. ChatService.requestSecret in production.
type WhatsAppSecretRequest = (botId: string, name: string, purpose: string, site: string) => Promise<unknown>;

interface WhatsAppSetupOptions {
    store: WhatsAppStore;
    secrets: WhatsAppSecretReader & { remove: (botId: string, name: string) => void };
    requestSecret: WhatsAppSecretRequest;
    // The address the owner reaches the server at. The Meta callback URL starts with it.
    publicBaseUrl: string;
}

interface WhatsAppFormOutcome {
    status: 'form';
    secretName: WhatsAppSecretName;
    isReplacement: boolean;
}

interface WhatsAppLinkedOutcome {
    status: 'linked';
    phoneNumberId: string;
    callbackUrl: string;
    isAlreadyLinked: boolean;
}

interface WhatsAppInvalidPhoneNumberIdOutcome {
    status: 'invalid-phone-number-id';
}

interface WhatsAppPhoneTakenOutcome {
    status: 'phone-taken';
}

interface WhatsAppBotLinkedOutcome {
    status: 'bot-linked';
    phoneNumberId: string;
}

type WhatsAppConnectOutcome
    = | WhatsAppFormOutcome
        | WhatsAppLinkedOutcome
        | WhatsAppInvalidPhoneNumberIdOutcome
        | WhatsAppPhoneTakenOutcome
        | WhatsAppBotLinkedOutcome;

const APP_SECRET_PURPOSE = 'Paste the App Secret of your Meta app. It is under App settings, Basic. CloudBot uses it to check that each WhatsApp webhook call comes from Meta.';
const APP_SECRET_REPLACEMENT_PURPOSE = 'The saved app secret is not valid. Paste the 32-character App Secret of your Meta app again. It is under App settings, Basic.';
const VERIFY_TOKEN_PURPOSE = 'Type a verify token for the Meta WhatsApp webhook. Use the same token in the Meta webhook settings.';
const VERIFY_TOKEN_REPLACEMENT_PURPOSE = 'The saved verify token is not valid. Type a verify token of up to 256 characters, and use the same token in the Meta webhook settings.';
const OWNER_NUMBER_PURPOSE = 'Type the WhatsApp number that may send you instructions, in international format, such as +15551234567.';
const OWNER_NUMBER_REPLACEMENT_PURPOSE = 'That number was not valid. Type the WhatsApp number that may send you instructions in international format, such as +15551234567.';

function buildWhatsAppCallbackUrl(publicBaseUrl: string): string {
    const baseUrl = publicBaseUrl.replace(/\/+$/, '');

    return `${baseUrl}${WHATSAPP_CALLBACK_PATH}`;
}

// Connects one bot to one Meta WhatsApp phone number. The bot posts a secure form for each secret it still needs,
// and the owner fills the form. The app secret, the verify token and the owner's number never reach the model.
class WhatsAppSetup {
    private readonly store: WhatsAppStore;
    private readonly secrets: WhatsAppSetupOptions['secrets'];
    private readonly requestSecret: WhatsAppSecretRequest;
    private readonly callbackUrl: string;

    constructor(options: WhatsAppSetupOptions) {
        this.store = options.store;
        this.secrets = options.secrets;
        this.requestSecret = options.requestSecret;
        this.callbackUrl = buildWhatsAppCallbackUrl(options.publicBaseUrl);
    }

    // Posts the next missing form, or links the number when all three secrets are valid.
    async connect(botId: string, rawPhoneNumberId: string): Promise<WhatsAppConnectOutcome> {
        const phoneNumberId = rawPhoneNumberId.trim();

        if (!isWhatsAppPhoneNumberId(phoneNumberId)) {
            return { status: 'invalid-phone-number-id' };
        }

        const appSecret = readWhatsAppAppSecret(this.secrets, botId);

        if (appSecret === undefined) {
            return this.requestForm(botId, WHATSAPP_APP_SECRET_NAME, APP_SECRET_PURPOSE, false);
        }

        if (!isWhatsAppAppSecret(appSecret)) {
            return this.requestForm(botId, WHATSAPP_APP_SECRET_NAME, APP_SECRET_REPLACEMENT_PURPOSE, true);
        }

        const verifyToken = readWhatsAppVerifyToken(this.secrets, botId);

        if (verifyToken === undefined) {
            const hadSavedVerifyToken = this.hasSavedSecret(botId, WHATSAPP_VERIFY_TOKEN_NAME);
            const verifyPurpose = hadSavedVerifyToken ? VERIFY_TOKEN_REPLACEMENT_PURPOSE : VERIFY_TOKEN_PURPOSE;

            return this.requestForm(botId, WHATSAPP_VERIFY_TOKEN_NAME, verifyPurpose, hadSavedVerifyToken);
        }

        const ownerNumber = readWhatsAppOwnerNumber(this.secrets, botId);

        if (ownerNumber === undefined) {
            const hadSavedOwnerNumber = this.hasSavedSecret(botId, WHATSAPP_OWNER_NUMBER_NAME);
            const ownerPurpose = hadSavedOwnerNumber ? OWNER_NUMBER_REPLACEMENT_PURPOSE : OWNER_NUMBER_PURPOSE;

            return this.requestForm(botId, WHATSAPP_OWNER_NUMBER_NAME, ownerPurpose, hadSavedOwnerNumber);
        }

        const linked = await this.store.link(botId, phoneNumberId);

        if (linked.status === 'phone-taken') {
            return { status: 'phone-taken' };
        }

        if (linked.status === 'bot-linked') {
            return { status: 'bot-linked', phoneNumberId: linked.phoneNumberId };
        }

        return { status: 'linked', phoneNumberId, callbackUrl: this.callbackUrl, isAlreadyLinked: !linked.isNew };
    }

    // Forgets the number and removes the three secrets. Returns false when the bot had no connection.
    async disconnect(botId: string): Promise<boolean> {
        const wasLinked = await this.store.unlink(botId);

        WHATSAPP_SECRET_NAMES.forEach((name) => {
            this.secrets.remove(botId, name);
        });

        return wasLinked;
    }

    private hasSavedSecret(botId: string, name: WhatsAppSecretName): boolean {
        return this.secrets.read(botId, name) !== undefined;
    }

    private async requestForm(botId: string, secretName: WhatsAppSecretName, purpose: string, isReplacement: boolean): Promise<WhatsAppConnectOutcome> {
        await this.requestSecret(botId, secretName, purpose, WHATSAPP_API_SITE);

        return { status: 'form', secretName, isReplacement };
    }
}

export { APP_SECRET_PURPOSE, APP_SECRET_REPLACEMENT_PURPOSE, OWNER_NUMBER_PURPOSE, VERIFY_TOKEN_PURPOSE, WhatsAppSetup, buildWhatsAppCallbackUrl };
export type {
    WhatsAppBotLinkedOutcome,
    WhatsAppConnectOutcome,
    WhatsAppFormOutcome,
    WhatsAppInvalidPhoneNumberIdOutcome,
    WhatsAppLinkedOutcome,
    WhatsAppPhoneTakenOutcome,
    WhatsAppSecretRequest,
    WhatsAppSetupOptions,
};
