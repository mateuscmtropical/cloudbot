import type { BotSummary, ChatEvent, ChatMessage, PendingUpload } from '../shared/chatTypes.ts';

const API_ROOT = '/api';

function botPath(botId: string, suffix: string): string {
    const encodedBotId = encodeURIComponent(botId);

    return `${API_ROOT}/bots/${encodedBotId}${suffix}`;
}

function messagePath(botId: string, messageId: string, suffix: string): string {
    const encodedMessageId = encodeURIComponent(messageId);

    return botPath(botId, `/messages/${encodedMessageId}${suffix}`);
}

interface ErrorResponseBody {
    error?: unknown;
}

class RequestFailedError extends Error {
    readonly status: number;
    // The server's own error text, shown to the user when present.
    readonly serverMessage: string | undefined;

    constructor(path: string, status: number, serverMessage?: string) {
        super(`Request to ${path} failed with status ${String(status)}`);
        this.name = 'RequestFailedError';
        this.status = status;
        this.serverMessage = serverMessage;
    }
}

function ensureOk(response: Response, path: string): void {
    if (!response.ok) {
        throw new RequestFailedError(path, response.status);
    }
}

async function readServerMessage(response: Response): Promise<string | undefined> {
    try {
        const body = (await response.json()) as ErrorResponseBody;

        return typeof body.error === 'string' ? body.error : undefined;
    } catch {
        return undefined;
    }
}

async function requestJson<ResponseBody>(path: string, init: RequestInit): Promise<ResponseBody> {
    const response = await fetch(path, init);

    if (!response.ok) {
        const serverMessage = await readServerMessage(response);

        throw new RequestFailedError(path, response.status, serverMessage);
    }

    const body = (await response.json()) as ResponseBody;

    return body;
}

function postJson<ResponseBody>(path: string, payload: unknown): Promise<ResponseBody> {
    const body = JSON.stringify(payload);
    const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };

    return requestJson<ResponseBody>(path, init);
}

function listBots(): Promise<BotSummary[]> {
    const path = `${API_ROOT}/bots`;

    return requestJson<BotSummary[]>(path, {});
}

interface MessagePageRequest {
    beforeSequence?: number;
    limit?: number;
}

// An empty request sends no query string, so the server answers with its default page.
function buildPageQuery(page: MessagePageRequest): string {
    const searchParams = new URLSearchParams();

    if (page.beforeSequence !== undefined) {
        const beforeText = String(page.beforeSequence);

        searchParams.set('before', beforeText);
    }

    if (page.limit !== undefined) {
        const limitText = String(page.limit);

        searchParams.set('limit', limitText);
    }

    const queryText = searchParams.toString();

    return queryText === '' ? '' : `?${queryText}`;
}

function listMessages(botId: string, page: MessagePageRequest = {}): Promise<ChatMessage[]> {
    const path = botPath(botId, '/messages');
    const query = buildPageQuery(page);

    return requestJson<ChatMessage[]>(`${path}${query}`, {});
}

function sendMessage(botId: string, text: string): Promise<ChatMessage> {
    const path = botPath(botId, '/messages');

    return postJson<ChatMessage>(path, { text });
}

function submitChoice(botId: string, messageId: string, choiceId: string): Promise<ChatMessage> {
    const path = messagePath(botId, messageId, '/choice');

    return postJson<ChatMessage>(path, { choiceId });
}

function submitCode(botId: string, messageId: string, code: string): Promise<ChatMessage> {
    const path = messagePath(botId, messageId, '/code');

    return postJson<ChatMessage>(path, { code });
}

// The secret goes straight to the server. Callers must not keep it.
function submitSecret(botId: string, messageId: string, value: string): Promise<ChatMessage> {
    const path = messagePath(botId, messageId, '/secret');

    return postJson<ChatMessage>(path, { value });
}

async function stopTurn(botId: string): Promise<void> {
    const path = botPath(botId, '/stop');
    const response = await fetch(path, { method: 'POST' });

    ensureOk(response, path);
}

async function uploadAttachments(botId: string, files: File[]): Promise<void> {
    const path = botPath(botId, '/attachments');
    const formData = new FormData();

    files.forEach((file) => {
        formData.append('files', file);
    });

    const response = await fetch(path, { method: 'POST', body: formData });

    if (!response.ok) {
        const serverMessage = await readServerMessage(response);

        throw new RequestFailedError(path, response.status, serverMessage);
    }
}

function listUploads(botId: string): Promise<PendingUpload[]> {
    const path = botPath(botId, '/uploads');

    return requestJson<PendingUpload[]>(path, {});
}

async function removeUpload(botId: string, uploadId: string): Promise<void> {
    const path = botPath(botId, `/uploads/${encodeURIComponent(uploadId)}`);
    const response = await fetch(path, { method: 'DELETE' });

    ensureOk(response, path);
}

// onOpen runs on the first connection and on every reconnect. Events missed while
// the stream was down are lost, so the caller reloads the conversation there.
function subscribeToEvents(botId: string, onEvent: (event: ChatEvent) => void, onOpen: () => void): () => void {
    const path = botPath(botId, '/events');
    const eventSource = new EventSource(path);

    eventSource.addEventListener('open', () => {
        onOpen();
    });

    eventSource.addEventListener('message', (messageEvent: MessageEvent<string>) => {
        const parsedEvent = JSON.parse(messageEvent.data) as ChatEvent;

        onEvent(parsedEvent);
    });

    return () => {
        eventSource.close();
    };
}

export type { MessagePageRequest };
export {
    RequestFailedError,
    listBots,
    listMessages,
    sendMessage,
    stopTurn,
    submitChoice,
    submitCode,
    submitSecret,
    subscribeToEvents,
    uploadAttachments,
    listUploads,
    removeUpload,
};
