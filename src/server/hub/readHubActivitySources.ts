import type { ActivitySources } from './activity.ts';

interface ActivityBot {
    id: string;
}

interface ActivityRoutine {
    isEnabled: boolean;
}

interface ActivityWatch {
    id: string;
}

interface ActivityWebhook {
    id: string;
}

interface ActivityWhatsAppConnection {
    botId: string;
}

interface ActivityBotStore {
    list: () => Promise<ActivityBot[]>;
}

interface ActivityRoutineStore {
    list: (botId: string) => Promise<ActivityRoutine[]>;
}

interface ActivityWatchStore {
    list: (botId: string) => Promise<ActivityWatch[]>;
}

interface ActivityWebhookStore {
    list: (botId: string) => Promise<ActivityWebhook[]>;
}

interface ActivityWhatsAppStore {
    list: () => Promise<ActivityWhatsAppConnection[]>;
}

interface ActivityChatService {
    hasConfiguredEmailAccount: (botId: string) => Promise<boolean>;
    isBusy: (botId: string) => boolean;
    isTelegramConnected: (botId: string) => boolean;
}

interface HubActivitySourceOptions {
    botStore?: ActivityBotStore;
    chatService?: ActivityChatService;
    routineStore?: ActivityRoutineStore;
    watchStore?: ActivityWatchStore;
    webhookStore?: ActivityWebhookStore;
    whatsappStore?: ActivityWhatsAppStore;
    hasAgentProgram?: () => Promise<boolean>;
    isReady: () => boolean;
}

async function readHubActivitySources(options: HubActivitySourceOptions): Promise<ActivitySources> {
    const bots = options.botStore === undefined ? [] : await options.botStore.list();
    const botIds = bots.map(bot => bot.id);
    const routineStore = options.routineStore;
    const watchStore = options.watchStore;
    const webhookStore = options.webhookStore;
    const whatsappStore = options.whatsappStore;
    const chatService = options.chatService;
    const routineReads = routineStore === undefined ? [] : botIds.map(botId => routineStore.list(botId));
    const routineLists = routineStore === undefined ? [] : await Promise.all(routineReads);
    const watchReads = watchStore === undefined ? [] : botIds.map(botId => watchStore.list(botId));
    const watchLists = watchStore === undefined ? [] : await Promise.all(watchReads);
    const webhookReads = webhookStore === undefined ? [] : botIds.map(botId => webhookStore.list(botId));
    const webhookLists = webhookStore === undefined ? [] : await Promise.all(webhookReads);
    const whatsappConnections = whatsappStore === undefined ? [] : await whatsappStore.list();
    const telegramConnections = chatService === undefined
        ? []
        : botIds.map(botId => chatService.isTelegramConnected(botId));
    const emailReads = chatService === undefined ? [] : botIds.map(botId => chatService.hasConfiguredEmailAccount(botId));
    const emailAccounts = chatService === undefined ? [] : await Promise.all(emailReads);
    const hasAgentProgram = options.hasAgentProgram === undefined ? false : await options.hasAgentProgram();

    return {
        hasActiveTurn: bots.some(bot => chatService?.isBusy(bot.id) ?? false),
        hasEnabledRoutine: routineLists.some(routines => routines.some(routine => routine.isEnabled)),
        hasEnabledWatch: watchLists.some(watches => watches.length > 0),
        hasWebhook: webhookLists.some(webhooks => webhooks.length > 0),
        hasWhatsAppConnection: whatsappConnections.length > 0,
        hasTelegramConnection: telegramConnections.some(isConnected => isConnected),
        hasEmailAccount: emailAccounts.some(hasAccount => hasAccount),
        hasAgentProgram,
        isLoginOrSetupInProgress: !options.isReady(),
    };
}

export { readHubActivitySources };
export type { HubActivitySourceOptions };
