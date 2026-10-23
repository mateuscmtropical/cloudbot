import { existsSync } from 'node:fs';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { setCookie } from 'hono/cookie';

import { readPublicHost, requireSameOrigin } from './access/requireSameOrigin.ts';
import { requireSession, SESSION_COOKIE_NAME } from './access/requireSession.ts';
import { createSecurityHeaders } from './access/securityHeaders.ts';
import type { AccessErrorResponse } from './access/requireSession.ts';
import type { SetupAccess } from './access/SetupAccess.ts';
import { createPasskeyRoutes } from './access/createPasskeyRoutes.ts';
import type { PasskeyService } from './access/PasskeyService.ts';
import { readPublicBaseUrl } from './access/setupLinkUrl.ts';
import type { PeopleAdmin } from './people/PeopleAdmin.ts';
import { createPeopleRoutes } from './people/createPeopleRoutes.ts';
import { readHubConfig } from './people/hubConfig.ts';

import { createChannelRoutes } from './channels/createChannelRoutes.ts';
import { createChatRoutes } from './chat/createChatRoutes.ts';
import type { ChatService } from './chat/ChatService.ts';
import { createHubActivityRoutes } from './hub/createHubActivityRoutes.ts';
import { hasAgentProgramListening } from './hub/listeningPrograms.ts';
import { readHubActivitySources } from './hub/readHubActivitySources.ts';
import type { BotStore } from './store/BotStore.ts';
import type { ChannelStore } from './store/ChannelStore.ts';
import { createScreenRoutes } from './desktop/createScreenRoutes.ts';
import type { ScreenViewName } from '../shared/chatTypes.ts';
import type { ScreenHolder } from './desktop/ScreenHolder.ts';
import { createPushRoutes } from './push/createPushRoutes.ts';
import type { PushRoutesOptions } from './push/createPushRoutes.ts';
import { createRuleRoutes } from './rules/createRuleRoutes.ts';
import { createAppRoutes } from './apps/createAppRoutes.ts';
import type { ConnectedApps } from './apps/ConnectedApps.ts';
import { createLimitRoutes } from './limits/createLimitRoutes.ts';
import { createModelRoutes } from './models/createModelRoutes.ts';
import { createProviderRoutes } from './providers/createProviderRoutes.ts';
import type { ProviderToolDependencies } from './providers/createProviderTools.ts';
import { createRoutineRoutes } from './routines/createRoutineRoutes.ts';
import type { LimitStore } from './store/LimitStore.ts';
import type { ModelStore } from './store/ModelStore.ts';
import type { RoutineStore } from './store/RoutineStore.ts';
import type { RuleStore } from './store/RuleStore.ts';
import type { WebhookStore } from './store/WebhookStore.ts';
import type { WatchStore } from './store/WatchStore.ts';
import { createWatchRoutes } from './watches/createWatchRoutes.ts';
import { createWebhookHookRoutes } from './webhooks/createWebhookHookRoutes.ts';
import { createWebhookRoutes } from './webhooks/createWebhookRoutes.ts';
import { DeliveryMemory, WebhookRefusalLog } from './webhooks/webhookMemory.ts';
import type { WhatsAppStore } from './store/WhatsAppStore.ts';
import { createWhatsAppWebhookRoutes } from './whatsapp/createWhatsAppWebhookRoutes.ts';
import type { WhatsAppSecretReader } from './whatsapp/whatsappSecrets.ts';

interface HealthResponse {
    status: 'ok';
    version: string;
}

interface AppOptions {
    version: string;
    access: SetupAccess;
    hubSecret?: string | undefined;
    // Passkey sign-in. Without it only the setup link signs the owner in.
    passkeys?: PasskeyService | undefined;
    // Only on the owner's instance inside the hub. It adds and removes people through the hub.
    peopleAdmin?: PeopleAdmin | undefined;
    webRoot?: string;
    chatService?: ChatService;
    // The channels the owner can see and post in. Without both stores the channel routes are not served.
    channelStore?: ChannelStore;
    botStore?: BotStore;
    ruleStore?: RuleStore;
    routineStore?: RoutineStore;
    modelStore?: ModelStore;
    // The AI providers the owner can pick for a bot, and the bot whose chat holds the sign-in. Without both the provider routes are not served.
    providers?: ProviderToolDependencies;
    setupBotId?: string;
    limitStore?: LimitStore;
    webhookStore?: WebhookStore;
    // The WhatsApp number each bot receives from. With the secrets, the public Meta webhook route is served.
    whatsappStore?: WhatsAppStore;
    whatsappSecrets?: WhatsAppSecretReader;
    // The refused webhook calls, shared with the ChatService so the bot sees them too. Without it a new log is used.
    webhookRefusals?: WebhookRefusalLog;
    // The delivery ids of each webhook, shared by the call route and the owner routes. Without it a new memory is used.
    webhookDeliveries?: DeliveryMemory;
    watchStore?: WatchStore;
    // The remote MCP servers the owner connected. Without it the owner's app routes are not served.
    connectedApps?: ConnectedApps;
    // The address new webhook URLs start with. Without it the server's own address is used.
    publicBaseUrl?: string;
    // CLOUDBOT_PUBLIC_URL. Requests that change state may also come from the host of this address.
    publicUrl?: string | undefined;
    // Webhook calls wait for the setup to finish. Without it the server is always ready.
    isReady?: () => boolean;
    screen?: ScreenHolder;
    // The live view of the screen. Docker uses VNC, and local mode uses the browser's frames.
    screenView?: ScreenViewName;
    // The browsers that turned notifications on, and the public key they subscribe with. Without it the push routes are not served.
    push?: PushRoutesOptions;
}

const DEFAULT_WEB_ROOT = 'dist/web';
const API_PREFIX = '/api/';
const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const SESSION_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
} as const;

// Vite names every file under assets after a hash of its content, so a browser may keep those for good.
// Every other file, such as index.html, is checked again on each visit, so a new build shows at once.
const HASHED_ASSET_PREFIX = '/assets/';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'no-cache';
const NO_STORE = 'no-store';

function skipApiRoutes(serve: MiddlewareHandler): MiddlewareHandler {
    return (context, next) => {
        if (context.req.path.startsWith(API_PREFIX)) {
            return next();
        }

        if (!context.req.path.startsWith(HASHED_ASSET_PREFIX)) {
            context.header('Cache-Control', REVALIDATE_CACHE);

            return serve(context, next);
        }

        context.header('Cache-Control', IMMUTABLE_CACHE);

        // A missing asset, such as a chunk of an older build, never falls back to index.html.
        // That page would be kept for a year under the asset's name.
        return serve(context, () => {
            context.header('Cache-Control', NO_STORE);
            context.res = context.body(null, 404);

            return Promise.resolve();
        });
    };
}

function createApp(options: AppOptions): Hono {
    const app = new Hono();
    const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
    const webhookRefusals = options.webhookRefusals ?? new WebhookRefusalLog();
    const webhookDeliveries = options.webhookDeliveries ?? new DeliveryMemory();
    const hubMode = readHubConfig(process.env) !== undefined;

    const publicHost = readPublicHost(options.publicUrl);
    const securityHeaders = createSecurityHeaders(publicHost);

    app.use('*', securityHeaders);

    // Health is registered before the session check, so it answers without a cookie.
    app.get('/api/health', (context) => {
        const body: HealthResponse = { status: 'ok', version: options.version };

        return context.json(body);
    });

    // A webhook call carries its own token in the URL, so this route is public. It sits outside the session check.
    if (options.chatService !== undefined && options.webhookStore !== undefined) {
        const chatService = options.chatService;
        const webhookHookRoutes = createWebhookHookRoutes({
            webhookStore: options.webhookStore,
            isReady: options.isReady ?? (() => true),
            sendMessage: (botId, text) => chatService.sendMessage(botId, text, 'webhook'),
            queuedWebhookTurns: botId => chatService.countQueuedWebhookTurns(botId),
            refusals: webhookRefusals,
            deliveries: webhookDeliveries,
        });

        app.route('/', webhookHookRoutes);
    }

    // Meta calls the WhatsApp webhook from outside, so this route also sits outside the session check.
    // Each call is checked against the app secret of its number before anything happens.
    if (options.chatService !== undefined && options.whatsappStore !== undefined && options.whatsappSecrets !== undefined) {
        const chatService = options.chatService;
        const whatsappRoutes = createWhatsAppWebhookRoutes({
            store: options.whatsappStore,
            secrets: options.whatsappSecrets,
            isReady: options.isReady ?? (() => true),
            sendMessage: (botId, text) => chatService.sendMessage(botId, text),
            postSystemNote: (botId, text) => chatService.postSystemNote(botId, text),
        });

        app.route('/', whatsappRoutes);
    }

    const sessionCheck = requireSession(options.access, options.hubSecret);
    const sameOriginCheck = requireSameOrigin({ publicHost });

    // The origin check runs first, so a request from another page is refused before the cookie is read.
    app.use('/api/*', sameOriginCheck);
    app.use('/api/*', sessionCheck);

    if (options.peopleAdmin !== undefined) {
        const peopleRoutes = createPeopleRoutes({ peopleAdmin: options.peopleAdmin });

        app.route('/', peopleRoutes);
    }

    if (hubMode) {
        const activityRoutes = createHubActivityRoutes({
            readSources: () => readHubActivitySources({
                ...(options.botStore === undefined ? {} : { botStore: options.botStore }),
                ...(options.chatService === undefined ? {} : { chatService: options.chatService }),
                ...(options.routineStore === undefined ? {} : { routineStore: options.routineStore }),
                ...(options.watchStore === undefined ? {} : { watchStore: options.watchStore }),
                ...(options.webhookStore === undefined ? {} : { webhookStore: options.webhookStore }),
                ...(options.whatsappStore === undefined ? {} : { whatsappStore: options.whatsappStore }),
                hasAgentProgram: () => hasAgentProgramListening({ agentUser: process.env.CLOUDBOT_AGENT_USER }),
                isReady: options.isReady ?? (() => true),
            }),
        });

        app.route('/', activityRoutes);
    }

    // Chat routes sit behind the session check. The web fallback would otherwise answer them.
    if (options.chatService !== undefined) {
        const chatRoutes = createChatRoutes(options.chatService);

        app.route('/', chatRoutes);
    }

    if (options.channelStore !== undefined && options.botStore !== undefined) {
        const channelRoutes = createChannelRoutes({ channels: options.channelStore, bots: options.botStore, rounds: options.chatService });

        app.route('/', channelRoutes);
    }

    if (options.chatService !== undefined && options.ruleStore !== undefined) {
        const chatService = options.chatService;
        const ruleRoutes = createRuleRoutes({ ruleStore: options.ruleStore, hasBot: botId => chatService.hasBot(botId) });

        app.route('/', ruleRoutes);
    }

    if (options.connectedApps !== undefined) {
        const connectedAppRoutes = createAppRoutes({
            connectedApps: options.connectedApps,
            ...(options.chatService === undefined ? {} : { chatService: options.chatService }),
        });

        app.route('/', connectedAppRoutes);
    }

    if (options.chatService !== undefined && options.routineStore !== undefined) {
        const chatService = options.chatService;
        const routineRoutes = createRoutineRoutes({ routineStore: options.routineStore, hasBot: botId => chatService.hasBot(botId) });

        app.route('/', routineRoutes);
    }

    if (options.chatService !== undefined && options.webhookStore !== undefined) {
        const chatService = options.chatService;
        const publicBaseUrl = options.publicBaseUrl ?? readPublicBaseUrl(process.env);
        const webhookRoutes = createWebhookRoutes({ webhookStore: options.webhookStore, hasBot: botId => chatService.hasBot(botId), publicBaseUrl, refusals: webhookRefusals, deliveries: webhookDeliveries });

        app.route('/', webhookRoutes);
    }

    if (options.chatService !== undefined && options.watchStore !== undefined) {
        const chatService = options.chatService;
        const watchRoutes = createWatchRoutes({ watchStore: options.watchStore, hasBot: botId => chatService.hasBot(botId) });

        app.route('/', watchRoutes);
    }

    if (options.chatService !== undefined && options.modelStore !== undefined) {
        const chatService = options.chatService;
        const modelRoutes = createModelRoutes({ modelStore: options.modelStore, hasBot: botId => chatService.hasBot(botId) });

        app.route('/', modelRoutes);
    }

    if (options.chatService !== undefined && options.modelStore !== undefined && options.providers !== undefined && options.setupBotId !== undefined) {
        const chatService = options.chatService;
        const providerRoutes = createProviderRoutes({ providers: options.providers, modelStore: options.modelStore, hasBot: botId => chatService.hasBot(botId), setupBotId: options.setupBotId });

        app.route('/', providerRoutes);
    }

    if (options.chatService !== undefined && options.limitStore !== undefined) {
        const chatService = options.chatService;
        const limitRoutes = createLimitRoutes({ limitStore: options.limitStore, hasBot: botId => chatService.hasBot(botId) });

        app.route('/', limitRoutes);
    }

    if (options.push !== undefined) {
        const pushRoutes = createPushRoutes(options.push);

        app.route('/', pushRoutes);
    }

    if (options.screen !== undefined) {
        const screenRoutes = createScreenRoutes(options.screen, options.screenView);

        app.route('/', screenRoutes);
    }

    if (options.passkeys !== undefined) {
        const passkeyRoutes = createPasskeyRoutes({ passkeys: options.passkeys, sessionCookieOptions: SESSION_COOKIE_OPTIONS, sameOriginCheck });

        app.route('/', passkeyRoutes);
    }

    app.get('/setup', async (context) => {
        if (hubMode) {
            return context.notFound();
        }

        const setupCode = context.req.query('code') ?? '';
        const sessionToken = await options.access.redeemSetupCode(setupCode);

        if (sessionToken === undefined) {
            const body: AccessErrorResponse = { error: 'This setup link is not valid. Ask the server for a new one.' };

            return context.json(body, 401);
        }

        setCookie(context, SESSION_COOKIE_NAME, sessionToken, SESSION_COOKIE_OPTIONS);

        return context.redirect('/');
    });

    // The web app is optional. Without a build the server only has the API.
    if (existsSync(webRoot)) {
        const serveFile = serveStatic({ root: webRoot });
        const serveIndex = serveStatic({ root: webRoot, path: 'index.html' });

        const serveFileUnlessApi = skipApiRoutes(serveFile);
        const serveIndexUnlessApi = skipApiRoutes(serveIndex);

        app.get('*', serveFileUnlessApi);
        // Unknown paths get index.html so the client-side router can take over.
        app.get('*', serveIndexUnlessApi);
    }

    return app;
}

export { createApp };
export type { AppOptions, HealthResponse };
