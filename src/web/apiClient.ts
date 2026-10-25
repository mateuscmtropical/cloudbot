import type { BotRule, BotSummary, ChatEvent, ChatMessage, PendingUpload, ScreenHolderName, ScreenViewName } from '../shared/chatTypes.ts';
import type { BitwardenStatus, BitwardenTestResult } from '../shared/bitwarden.ts';
import type { AppSignInStart, ConnectedAppSummary } from '../shared/connectedApps.ts';
import type { BotRoutine } from '../shared/routineTypes.ts';
import type { BotWatch } from '../shared/watchTypes.ts';
import type { BotWebhook, CreatedBotWebhook } from '../shared/webhookTypes.ts';
import type { TurnLimits } from '../shared/limitTypes.ts';
import type { ChannelDetail, ChannelPostView, ChannelSummary } from '../shared/channelTypes.ts';
import type { BotProviderSummary, ProviderChoiceSummary, ProviderConnectResponse } from '../shared/providerTypes.ts';
import type { PushKeyResponse, PushSubscriptionInput, PushUnsubscribeInput } from '../shared/pushTypes.ts';
import { compressImage } from './compressImage.ts';

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

function listChannels(): Promise<ChannelSummary[]> {
    return requestJson<ChannelSummary[]>(`${API_ROOT}/channels`, {});
}

function getChannel(channelId: string): Promise<ChannelDetail> {
    const path = `${API_ROOT}/channels/${encodeURIComponent(channelId)}`;

    return requestJson<ChannelDetail>(path, {});
}

function postChannelMessage(channelId: string, text: string): Promise<ChannelPostView> {
    const path = `${API_ROOT}/channels/${encodeURIComponent(channelId)}/messages`;

    return postJson<ChannelPostView>(path, { text });
}

// Stops the whole round of the channel. The server answers with whether a round was running.
function stopChannel(channelId: string): Promise<{ stopped: boolean }> {
    const path = `${API_ROOT}/channels/${encodeURIComponent(channelId)}/stop`;

    return postJson<{ stopped: boolean }>(path, {});
}

// The "+" button. The server makes the bot and opens its chat with the question about its name and job.
function createBot(): Promise<BotSummary> {
    return postJson<BotSummary>(`${API_ROOT}/bots`, {});
}

// Deletes the bot and everything of it. A refusal carries the server's reason, such as the last bot.
async function deleteBot(botId: string): Promise<void> {
    const path = botPath(botId, '');

    await requestJson<unknown>(path, { method: 'DELETE' });
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
    const compressions = files.map(compressImage);
    const preparedFiles = await Promise.all(compressions);

    preparedFiles.forEach((file) => {
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

interface ScreenStateResponse {
    holder: ScreenHolderName;
}

async function getScreenHolder(): Promise<ScreenHolderName> {
    const state = await requestJson<ScreenStateResponse>(`${API_ROOT}/desktop/screen`, {});

    return state.holder;
}

interface ScreenViewResponse {
    view: ScreenViewName;
}

async function getScreenView(): Promise<ScreenViewName> {
    const response = await requestJson<ScreenViewResponse>(`${API_ROOT}/desktop/view`, {});

    return response.view;
}

async function takeScreen(): Promise<ScreenHolderName> {
    const state = await requestJson<ScreenStateResponse>(`${API_ROOT}/desktop/screen/take`, { method: 'POST' });

    return state.holder;
}

async function releaseScreen(): Promise<ScreenHolderName> {
    const state = await requestJson<ScreenStateResponse>(`${API_ROOT}/desktop/screen/release`, { method: 'POST' });

    return state.holder;
}

interface NewRuleRequest {
    kind: BotRule['kind'];
    text: string;
    blockedTools: string[];
}

function listRules(botId: string): Promise<BotRule[]> {
    const path = botPath(botId, '/rules');

    return requestJson<BotRule[]>(path, {});
}

function addRule(botId: string, rule: NewRuleRequest): Promise<BotRule> {
    const path = botPath(botId, '/rules');

    return postJson<BotRule>(path, rule);
}

async function removeRule(botId: string, ruleId: string): Promise<void> {
    const path = botPath(botId, `/rules/${encodeURIComponent(ruleId)}`);
    const response = await fetch(path, { method: 'DELETE' });

    if (!response.ok) {
        const serverMessage = await readServerMessage(response);

        throw new RequestFailedError(path, response.status, serverMessage);
    }
}

function listRoutines(botId: string): Promise<BotRoutine[]> {
    const path = botPath(botId, '/routines');

    return requestJson<BotRoutine[]>(path, {});
}

async function removeRoutine(botId: string, routineId: string): Promise<void> {
    const path = botPath(botId, `/routines/${encodeURIComponent(routineId)}`);
    const response = await fetch(path, { method: 'DELETE' });

    if (!response.ok) {
        const serverMessage = await readServerMessage(response);

        throw new RequestFailedError(path, response.status, serverMessage);
    }
}

function listWebhooks(botId: string): Promise<BotWebhook[]> {
    const path = botPath(botId, '/webhooks');

    return requestJson<BotWebhook[]>(path, {});
}

// The response carries the URL. The caller shows it once and must not keep it.
function createWebhook(botId: string, name: string): Promise<CreatedBotWebhook> {
    const path = botPath(botId, '/webhooks');

    return postJson<CreatedBotWebhook>(path, { name });
}

function listWatches(botId: string): Promise<BotWatch[]> {
    const path = botPath(botId, '/watches');

    return requestJson<BotWatch[]>(path, {});
}

async function removeWatch(botId: string, watchId: string): Promise<void> {
    const path = botPath(botId, `/watches/${encodeURIComponent(watchId)}`);
    const response = await fetch(path, { method: 'DELETE' });

    if (!response.ok) {
        const serverMessage = await readServerMessage(response);

        throw new RequestFailedError(path, response.status, serverMessage);
    }
}

async function removeWebhook(botId: string, webhookId: string): Promise<void> {
    const path = botPath(botId, `/webhooks/${encodeURIComponent(webhookId)}`);
    const response = await fetch(path, { method: 'DELETE' });

    if (!response.ok) {
        const serverMessage = await readServerMessage(response);

        throw new RequestFailedError(path, response.status, serverMessage);
    }
}

// How much thinking a kind of work gets. A null effort is the CLI default.
type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// The model and effort choice of each kind of work. A null choice is the default, or no helper for browsing and documents.
interface ModelSettings {
    chat: string | null;
    routines: string | null;
    review: string | null;
    browsing: string | null;
    documents: string | null;
    chatEffort: EffortLevel | null;
    routinesEffort: EffortLevel | null;
    reviewEffort: EffortLevel | null;
    browsingEffort: EffortLevel | null;
    documentsEffort: EffortLevel | null;
}

interface ModelSettingsResponse extends ModelSettings {
    // The aliases the server accepts. The panel offers exactly these.
    aliases: string[];
    // The effort levels the server accepts, besides the default.
    effortLevels: EffortLevel[];
}

// The owner renames a bot. The server refuses a name that is empty, too long, on two lines or taken in a channel of the bot.
function renameBot(botId: string, name: string): Promise<BotSummary> {
    const path = botPath(botId, '/name');
    const init: RequestInit = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) };

    return requestJson<BotSummary>(path, init);
}

function getModelSettings(botId: string): Promise<ModelSettingsResponse> {
    const path = botPath(botId, '/models');

    return requestJson<ModelSettingsResponse>(path, {});
}

function saveModelSettings(botId: string, settings: ModelSettings): Promise<ModelSettings> {
    const path = botPath(botId, '/models');
    const init: RequestInit = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) };

    return requestJson<ModelSettings>(path, init);
}

// The AI provider a bot runs on. A switch takes effect from the next message.
function getBotProvider(botId: string): Promise<BotProviderSummary> {
    const path = botPath(botId, '/provider');

    return requestJson<BotProviderSummary>(path, {});
}

function switchBotProvider(botId: string, provider: string): Promise<BotProviderSummary> {
    const path = botPath(botId, '/provider');
    const init: RequestInit = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) };

    return requestJson<BotProviderSummary>(path, init);
}

function saveProviderModel(botId: string, model: string | null, effort: string | null): Promise<BotProviderSummary> {
    const path = botPath(botId, '/provider/model');
    const init: RequestInit = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, effort }) };

    return requestJson<BotProviderSummary>(path, init);
}

// The providers of the server and which ones the owner connected. The server checks each sign-in, so this call can take a moment.
function listProviders(): Promise<ProviderChoiceSummary[]> {
    return requestJson<ProviderChoiceSummary[]>(`${API_ROOT}/providers`, {});
}

// Posts the provider list in the setup chat. The answer names the bot whose chat holds the sign-in.
function startProviderConnect(): Promise<ProviderConnectResponse> {
    return requestJson<ProviderConnectResponse>(`${API_ROOT}/providers/connect`, { method: 'POST' });
}

interface LimitBound {
    min: number;
    max: number;
    isWhole: boolean;
}

interface LimitsResponse extends TurnLimits {
    // The range of each limit kind. The panel builds its inputs from it.
    bounds: Record<'minutes' | 'usd' | 'steps', LimitBound>;
}

function getLimits(botId: string): Promise<LimitsResponse> {
    const path = botPath(botId, '/limits');

    return requestJson<LimitsResponse>(path, {});
}

function saveLimits(botId: string, limits: TurnLimits): Promise<TurnLimits> {
    const path = botPath(botId, '/limits');
    const init: RequestInit = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(limits) };

    return requestJson<TurnLimits>(path, init);
}

const STREAM_RETRY_MS = 3000;

// A phone that turns its screen off or leaves the app can keep a dead stream that still looks open, and a stream
// that gets an error page while a hibernated bot wakes up is closed by the browser for good. So the stream opens
// again whenever the page is shown or the network comes back, and again a moment after the browser gave up on it.
function openEventStream(path: string, onEvent: (event: ChatEvent) => void, onOpen: () => void): () => void {
    const stream: { source: EventSource | undefined; retry: number | undefined } = { source: undefined, retry: undefined };

    const connect = (): void => {
        window.clearTimeout(stream.retry);
        stream.source?.close();

        const eventSource = new EventSource(path);

        stream.source = eventSource;
        eventSource.addEventListener('open', () => {
            onOpen();
        });
        eventSource.addEventListener('message', (messageEvent: MessageEvent<string>) => {
            const parsedEvent = JSON.parse(messageEvent.data) as ChatEvent;

            onEvent(parsedEvent);
        });
        eventSource.addEventListener('error', () => {
            if (eventSource.readyState === EventSource.CLOSED) {
                stream.retry = window.setTimeout(connect, STREAM_RETRY_MS);
            }
        });
    };
    const connectWhenShown = (): void => {
        if (document.visibilityState === 'visible') {
            connect();
        }
    };

    connect();
    document.addEventListener('visibilitychange', connectWhenShown);
    window.addEventListener('online', connect);

    return () => {
        document.removeEventListener('visibilitychange', connectWhenShown);
        window.removeEventListener('online', connect);
        window.clearTimeout(stream.retry);
        stream.source?.close();
    };
}

// onOpen runs on the first connection and on every reconnect. Events missed while
// the stream was down are lost, so the caller reloads the conversation there.
function subscribeToEvents(botId: string, onEvent: (event: ChatEvent) => void, onOpen: () => void): () => void {
    const path = botPath(botId, '/events');

    return openEventStream(path, onEvent, onOpen);
}

// The messages of every bot in one stream. The caller reloads the bot list on open, since events missed while it was down are lost.
function subscribeToAllBotEvents(onEvent: (event: ChatEvent) => void, onOpen: () => void): () => void {
    return openEventStream(`${API_ROOT}/events`, onEvent, onOpen);
}

// The remote MCP servers the owner connected. The list never holds a token.
function listConnectedApps(): Promise<ConnectedAppSummary[]> {
    return requestJson<ConnectedAppSummary[]>('/api/apps', {});
}

// Asks where the server's own sign-in page is. The answer is an address to open, or that the server has none.
function startAppSignIn(botId: string, name: string, url: string): Promise<AppSignInStart> {
    const path = `${API_ROOT}/apps/oauth/start`;

    return postJson<AppSignInStart>(path, { botId, name, url });
}

// Whether the owner saved a Bitwarden account for this bot, and for which server. No secret is sent back.
function getBitwardenStatus(botId: string): Promise<BitwardenStatus> {
    const path = `${API_ROOT}/apps/bitwarden/account?bot=${encodeURIComponent(botId)}`;

    return requestJson<BitwardenStatus>(path, {});
}

interface BitwardenAccountFields {
    serverUrl: string;
    clientId: string;
    clientSecret: string;
    masterPassword: string;
}

function saveBitwardenAccount(botId: string, fields: BitwardenAccountFields): Promise<BitwardenStatus> {
    const path = `${API_ROOT}/apps/bitwarden/account`;
    const init: RequestInit = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, ...fields }) };

    return requestJson<BitwardenStatus>(path, init);
}

async function forgetBitwardenAccount(botId: string): Promise<void> {
    const path = `${API_ROOT}/apps/bitwarden/account?bot=${encodeURIComponent(botId)}`;
    const response = await fetch(path, { method: 'DELETE' });

    if (!response.ok) {
        const serverMessage = await readServerMessage(response);

        throw new RequestFailedError(path, response.status, serverMessage);
    }
}

// Signs in, unlocks and syncs on the server. The answer is ok, or one plain sentence.
function testBitwardenAccount(botId: string): Promise<BitwardenTestResult> {
    const path = `${API_ROOT}/apps/bitwarden/test`;

    return postJson<BitwardenTestResult>(path, { botId });
}

function startAppConnection(botId: string, name: string, url: string): Promise<ChatMessage> {
    const path = `${API_ROOT}/apps/connect`;

    return postJson<ChatMessage>(path, { botId, name, url });
}

async function removeConnectedApp(appId: string): Promise<void> {
    const path = `/api/apps/${encodeURIComponent(appId)}`;
    const response = await fetch(path, { method: 'DELETE' });

    if (!response.ok) {
        const serverMessage = await readServerMessage(response);

        throw new RequestFailedError(path, response.status, serverMessage);
    }
}

// The public key of the server. The browser passes it to its push service when it subscribes.
function getPushKey(): Promise<PushKeyResponse> {
    return requestJson<PushKeyResponse>(`${API_ROOT}/push/key`, {});
}

// Saves the subscription of this browser. A refusal carries the server's reason, such as an unknown push service.
async function savePushSubscription(subscription: PushSubscriptionInput): Promise<void> {
    const path = `${API_ROOT}/push/subscriptions`;
    const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription) };
    const response = await fetch(path, init);

    if (!response.ok) {
        const serverMessage = await readServerMessage(response);

        throw new RequestFailedError(path, response.status, serverMessage);
    }
}
// Removes the subscription of this browser. The server answers the same for one it does not know.
async function removePushSubscription(endpoint: string): Promise<void> {
    const path = `${API_ROOT}/push/subscriptions`;
    const body: PushUnsubscribeInput = { endpoint };
    const init: RequestInit = { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const response = await fetch(path, init);

    if (!response.ok) {
        const serverMessage = await readServerMessage(response);

        throw new RequestFailedError(path, response.status, serverMessage);
    }
}
export type { EffortLevel, LimitBound, LimitsResponse, MessagePageRequest, ModelSettings, ModelSettingsResponse, NewRuleRequest };
export {
    RequestFailedError,
    listConnectedApps,
    getBitwardenStatus,
    saveBitwardenAccount,
    forgetBitwardenAccount,
    testBitwardenAccount,
    startAppConnection,
    startAppSignIn,
    removeConnectedApp,
    createBot,
    deleteBot,
    listBots,
    listChannels,
    getChannel,
    postChannelMessage,
    stopChannel,
    listMessages,
    sendMessage,
    stopTurn,
    submitChoice,
    submitCode,
    submitSecret,
    subscribeToEvents,
    subscribeToAllBotEvents,
    uploadAttachments,
    listUploads,
    removeUpload,
    getScreenHolder,
    getScreenView,
    takeScreen,
    releaseScreen,
    listRules,
    addRule,
    removeRule,
    listRoutines,
    removeRoutine,
    listWebhooks,
    createWebhook,
    removeWebhook,
    listWatches,
    removeWatch,
    getBotProvider,
    getModelSettings,
    listProviders,
    startProviderConnect,
    switchBotProvider,
    saveProviderModel,
    renameBot,
    saveModelSettings,
    getLimits,
    saveLimits,
    getPushKey,
    savePushSubscription,
    removePushSubscription,
};
