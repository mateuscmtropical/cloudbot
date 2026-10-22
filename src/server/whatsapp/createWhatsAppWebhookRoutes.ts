import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { WhatsAppConnectionRecord, WhatsAppStore } from '../store/WhatsAppStore.ts';
import type { WhatsAppInboundMessage } from './whatsappPayload.ts';
import { parseWhatsAppPayload } from './whatsappPayload.ts';
import { matchesWhatsAppVerifyToken, verifyWhatsAppSignature } from './whatsappSignature.ts';
import {
    WHATSAPP_CALLBACK_PATH,
    readWhatsAppAppSecret,
    readWhatsAppOwnerNumber,
    readWhatsAppVerifyToken,
} from './whatsappSecrets.ts';
import type { WhatsAppSecretReader } from './whatsappSecrets.ts';

interface WhatsAppErrorResponse {
    error: string;
}

interface WhatsAppAcceptedResponse {
    status: 'received';
}

interface WhatsAppWebhookRoutesOptions {
    store: WhatsAppStore;
    secrets: WhatsAppSecretReader;
    // A message waits for the setup to finish, as a chat message does.
    isReady: () => boolean;
    // The text goes through the same queue as a chat message, so it uses the chat model and limits.
    sendMessage: (botId: string, text: string) => Promise<unknown>;
    // A note in the chat for a message type CloudBot does not handle.
    postSystemNote: (botId: string, text: string) => Promise<unknown>;
    now?: () => number;
}

const MAX_BODY_BYTES = 1024 * 1024;
// Meta retries a failed delivery for up to 7 days. The message ids live a little longer, so a retry is still seen.
const MESSAGE_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
const SIGNATURE_HEADER = 'X-Hub-Signature-256';
const UNSUPPORTED_MESSAGE_NOTE = 'The owner sent a WhatsApp message that is not text. Only text messages are supported yet.';

const INVALID_BODY: WhatsAppErrorResponse = { error: 'The WhatsApp payload is not valid.' };
const INVALID_SIGNATURE: WhatsAppErrorResponse = { error: 'The signature is not valid.' };
const NOT_READY: WhatsAppErrorResponse = { error: 'CloudBot is starting. Try again in a moment.' };
const HANDLING_FAILED: WhatsAppErrorResponse = { error: 'The WhatsApp message could not be handled.' };
const TOO_LARGE: WhatsAppErrorResponse = { error: `The body is larger than ${String(MAX_BODY_BYTES)} bytes.` };
const ACCEPTED: WhatsAppAcceptedResponse = { status: 'received' };
const FORBIDDEN_TEXT = 'Forbidden';

// The connected numbers in the body pick the app secrets that may have signed it. A body with only unknown numbers
// is checked against every connection, so Meta's status callbacks still get an answer and change nothing.
async function readCandidateConnections(store: WhatsAppStore, phoneNumberIds: string[]): Promise<WhatsAppConnectionRecord[]> {
    if (phoneNumberIds.length === 0) {
        return store.list();
    }

    const foundRowsPromises = phoneNumberIds.map(phoneNumberId => store.findByPhoneNumberId(phoneNumberId));
    const foundRows = await Promise.all(foundRowsPromises);
    const connections = foundRows.filter((record): record is WhatsAppConnectionRecord => record !== undefined);

    return connections.length === 0 ? store.list() : connections;
}

function readVerifiedBotIds(rawBody: Uint8Array, signatureHeader: string | undefined, connections: WhatsAppConnectionRecord[], secrets: WhatsAppSecretReader): Set<string> {
    const verifiedBotIds = new Set<string>();

    connections.forEach((connection) => {
        const appSecret = readWhatsAppAppSecret(secrets, connection.botId);

        if (appSecret !== undefined && verifyWhatsAppSignature(rawBody, signatureHeader, appSecret)) {
            verifiedBotIds.add(connection.botId);
        }
    });

    return verifiedBotIds;
}

async function releaseClaim(store: WhatsAppStore, messageId: string): Promise<void> {
    try {
        await store.releaseMessage(messageId);
    } catch {
        console.error('Could not release a WhatsApp message id after a failure.');
    }
}

async function processMessage(message: WhatsAppInboundMessage, options: WhatsAppWebhookRoutesOptions, connectionsByPhoneNumberId: Map<string, WhatsAppConnectionRecord>, verifiedBotIds: Set<string>): Promise<void> {
    const connection = connectionsByPhoneNumberId.get(message.phoneNumberId);

    // A number that is not connected or was signed by another app changes nothing.
    if (connection === undefined || !verifiedBotIds.has(connection.botId)) {
        return;
    }

    const ownerNumber = readWhatsAppOwnerNumber(options.secrets, connection.botId);

    // Any other sender is dropped silently, with no turn and no reply.
    if (ownerNumber === undefined || ownerNumber !== message.from) {
        return;
    }

    // The id is taken before the side effect, so two calls with the same message handle it once.
    const isClaimed = await options.store.claimMessage(message.messageId, connection.botId);

    if (!isClaimed) {
        return;
    }

    try {
        if (message.kind === 'text') {
            await options.sendMessage(connection.botId, message.text);
        } else {
            await options.postSystemNote(connection.botId, UNSUPPORTED_MESSAGE_NOTE);
        }
    } catch (error: unknown) {
        // The claim goes back, so Meta's retry can handle the message again.
        await releaseClaim(options.store, message.messageId);

        throw error;
    }
}

// This route is public, like the webhook hook route, so it sits outside the session check. Meta calls it.
function createWhatsAppWebhookRoutes(options: WhatsAppWebhookRoutesOptions): Hono {
    const routes = new Hono();
    const now = options.now ?? (() => Date.now());
    const limitBody = bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: context => context.json(TOO_LARGE, 413),
    });

    // Meta's verification handshake. The token is checked against every connected bot, because one callback URL may
    // serve several connections.
    routes.get(WHATSAPP_CALLBACK_PATH, async (context) => {
        const mode = context.req.query('hub.mode') ?? '';
        const providedToken = context.req.query('hub.verify_token') ?? '';
        const challenge = context.req.query('hub.challenge') ?? '';

        if (mode !== 'subscribe' || providedToken === '' || challenge === '') {
            return context.text(FORBIDDEN_TEXT, 403);
        }

        const connections = await options.store.list();
        const isMatch = connections.some((connection) => {
            const expectedToken = readWhatsAppVerifyToken(options.secrets, connection.botId);

            return expectedToken !== undefined && matchesWhatsAppVerifyToken(providedToken, expectedToken);
        });

        if (!isMatch) {
            return context.text(FORBIDDEN_TEXT, 403);
        }

        return context.text(challenge, 200);
    });

    routes.post(WHATSAPP_CALLBACK_PATH, limitBody, async (context) => {
        const rawBuffer = await context.req.arrayBuffer();
        const rawBody = new Uint8Array(rawBuffer);
        const bodyText = new TextDecoder()
            .decode(rawBody);
        const signatureHeader = context.req.header(SIGNATURE_HEADER);
        let payload: unknown;

        try {
            payload = JSON.parse(bodyText);
        } catch {
            const connections = await options.store.list();
            const verifiedBotIds = readVerifiedBotIds(rawBody, signatureHeader, connections, options.secrets);

            if (verifiedBotIds.size === 0) {
                return context.json(INVALID_SIGNATURE, 401);
            }

            return context.json(INVALID_BODY, 400);
        }

        const parsed = parseWhatsAppPayload(payload);
        const connections = await readCandidateConnections(options.store, parsed.phoneNumberIds);
        const verifiedBotIds = readVerifiedBotIds(rawBody, signatureHeader, connections, options.secrets);

        // No connection could have signed this call, so it did not come from Meta.
        if (verifiedBotIds.size === 0) {
            return context.json(INVALID_SIGNATURE, 401);
        }

        // A status callback changes nothing, so it is answered even while CloudBot starts.
        if (parsed.messages.length > 0 && !options.isReady()) {
            return context.json(NOT_READY, 503);
        }

        const connectionEntries = connections.map(connection => [connection.phoneNumberId, connection] as const);
        const connectionsByPhoneNumberId = new Map(connectionEntries);
        const initialProcessing = Promise.resolve();
        const processed = parsed.messages.reduce<Promise<void>>(async (previous, message) => {
            await previous;
            await processMessage(message, options, connectionsByPhoneNumberId, verifiedBotIds);
        }, initialProcessing);

        try {
            await processed;
        } catch {
            console.error('A WhatsApp message could not be handled. Meta may send it again.');

            // The claim of the failed message was already given back.
            return context.json(HANDLING_FAILED, 500);
        }

        try {
            await options.store.removeOldMessages(now() - MESSAGE_RETENTION_MS);
        } catch {
            console.error('Could not remove old WhatsApp message ids.');
        }

        return context.json(ACCEPTED, 200);
    });

    return routes;
}

export { MAX_BODY_BYTES, MESSAGE_RETENTION_MS, SIGNATURE_HEADER, UNSUPPORTED_MESSAGE_NOTE, createWhatsAppWebhookRoutes };
export type { WhatsAppAcceptedResponse, WhatsAppErrorResponse, WhatsAppWebhookRoutesOptions };
