import { z } from 'zod/v4';

import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import { PROVIDER_IDS, PROVIDER_LABELS } from './providerIds.ts';
import type { ProviderId } from './providerIds.ts';

interface ProviderToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

interface ProviderToolDependencies {
    // The providers this server can run. A provider without its CLI is left out.
    available: ProviderId[];
    connected: () => Promise<ProviderId[]>;
    providerFor: (botId: string) => Promise<ProviderId>;
    setProvider: (botId: string, provider: ProviderId) => Promise<void>;
    // Posts the provider list in the setup chat.
    offerProviders: () => Promise<void>;
}

const PROVIDER_LIST_TOOL_NAME = 'provider_list';
const PROVIDER_USE_TOOL_NAME = 'provider_use';
const PROVIDER_CONNECT_TOOL_NAME = 'provider_connect';
const PROVIDER_TOOL_FULL_NAMES = [PROVIDER_LIST_TOOL_NAME, PROVIDER_USE_TOOL_NAME, PROVIDER_CONNECT_TOOL_NAME].map(name => `mcp__${PROFILE_SERVER_NAME}__${name}`);

function textResult(text: string, isError = false): ProviderToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function describeProvider(provider: ProviderId, connected: ProviderId[], current: ProviderId): string {
    const state = connected.includes(provider) ? 'connected' : 'not connected';
    const mark = provider === current ? ', used by this bot' : '';

    return `${PROVIDER_LABELS[provider]} (${provider}, ${state}${mark})`;
}

// The bot id is fixed when the tools are built, so a bot can only change its own provider.
function createProviderTools(dependencies: ProviderToolDependencies, botId: string): CloudbotTool[] {
    const listTool = tool(
        PROVIDER_LIST_TOOL_NAME,
        'List the AI providers this server supports, which ones are connected, and which one you run on. Use it when the owner asks about subscriptions or providers.',
        {},
        async (): Promise<ProviderToolResult> => {
            const connected = await dependencies.connected();
            const current = await dependencies.providerFor(botId);
            const lines = dependencies.available.map(provider => describeProvider(provider, connected, current));

            return textResult(`Providers: ${lines.join(', ')}.`);
        },
    );
    const useTool = tool(
        PROVIDER_USE_TOOL_NAME,
        'Switch the AI provider you run on, when the owner asks for it. The provider must be connected. The next message runs on it and starts a new conversation there. Your model choices name Claude models, so other providers use their own default model.',
        { provider: z.enum(PROVIDER_IDS) },
        async ({ provider }): Promise<ProviderToolResult> => {
            if (!dependencies.available.includes(provider)) {
                return textResult(`${PROVIDER_LABELS[provider]} is not installed on this server.`, true);
            }

            const connected = await dependencies.connected();

            if (!connected.includes(provider)) {
                return textResult(`${PROVIDER_LABELS[provider]} is not connected. Call provider_connect so the owner can sign in first.`, true);
            }

            await dependencies.setProvider(botId, provider);

            return textResult(`From the next message you run on ${PROVIDER_LABELS[provider]}.`);
        },
    );
    const connectTool = tool(
        PROVIDER_CONNECT_TOOL_NAME,
        'Post the list of AI providers in the CloudBot setup chat, so the owner can sign in to another subscription. Tell the owner to open the CloudBot chat and pick one.',
        {},
        async (): Promise<ProviderToolResult> => {
            await dependencies.offerProviders();

            return textResult('The provider list is in the CloudBot chat. The owner picks one there and signs in on the provider page.');
        },
    );

    return [listTool, useTool, connectTool] as CloudbotTool[];
}

export { PROVIDER_TOOL_FULL_NAMES, createProviderTools };
export type { ProviderToolDependencies };
