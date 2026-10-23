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
}

interface ProviderModelOptionSummary {
    id: string;
    label: string;
    efforts: string[];
}

// The bot where the owner connects a provider. Its chat shows the sign-in.
interface ProviderConnectResponse {
    botId: string;
}

export type { BotProviderSummary, ProviderChoiceSummary, ProviderConnectResponse, ProviderModelOptionSummary };
