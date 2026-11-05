import type { PermissionMode } from './permissionModes.ts';

// One AI provider the server can run, and whether the owner connected it.
interface ProviderChoiceSummary {
    id: string;
    label: string;
    isConnected: boolean;
}

// The provider a bot runs on.
interface BotProviderSummary {
    provider: string;
    label: string;
    // The model of the chat, or null for the default model of the provider.
    model: string | null;
    // The choices the current provider reported after a session, empty when it has no model selector.
    modelOptions: ProviderModelOptionSummary[];
    // The stored choice. Null means the provider default.
    selectedModel: string | null;
    selectedEffort: string | null;
    // Efforts reported for the selected model, or the provider default model.
    effortOptions: string[];
    // How freely the bot runs tools. It belongs to the bot, so it stays when the provider changes.
    permissionMode: PermissionMode;
}

interface ProviderModelOptionSummary {
    id: string;
    label: string;
    efforts: string[];
}

// What one kind of work runs on, such as routines, and what the owner can choose for it.
interface WorkKindSummary {
    kind: string;
    label: string;
    // The owner's choice. Null follows the chat.
    provider: string | null;
    usedProvider: string;
    usedProviderLabel: string;
    // The real name when it is known, and null until the provider reported its default.
    usedModel: string | null;
    usedEffort: string | null;
    selectedModel: string | null;
    selectedEffort: string | null;
    // Empty when the work takes these from the chat or the provider lists no models yet.
    modelOptions: ProviderModelOptionSummary[];
    effortOptions: string[];
    // Null when every connected provider can run this work.
    allowedProviders: string[] | null;
}

// The bot where the owner connects a provider. Its chat shows the sign-in.
interface ProviderConnectResponse {
    botId: string;
}

export type { BotProviderSummary, ProviderChoiceSummary, ProviderConnectResponse, ProviderModelOptionSummary, WorkKindSummary };
