import { z } from 'zod/v4';

import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import { WORK_KINDS } from './WorkSettings.ts';
import type { WorkSettings } from './WorkSettings.ts';
import { PROVIDER_IDS, PROVIDER_LABELS } from './providerIds.ts';
import type { ProviderId } from './providerIds.ts';

interface WorkToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

interface WorkToolDependencies {
    workSettings: Pick<WorkSettings, 'describe' | 'save'>;
    connected: () => Promise<ProviderId[]>;
    // The chat's own provider and model, as the provider picker shows them.
    describeChat: () => Promise<string>;
}

const WORK_SETTINGS_LIST_TOOL_NAME = 'work_settings_list';
const WORK_SETTINGS_SET_TOOL_NAME = 'work_settings_set';
const WORK_SETTINGS_LIST_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WORK_SETTINGS_LIST_TOOL_NAME}`;
const WORK_SETTINGS_SET_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WORK_SETTINGS_SET_TOOL_NAME}`;

function textResult(text: string, isError = false): WorkToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

async function describeWork(dependencies: WorkToolDependencies, botId: string): Promise<string> {
    const summaries = await dependencies.workSettings.describe(botId);
    const lines = summaries.map((summary) => {
        const follows = summary.provider === null ? ', follows the chat' : '';

        return `${summary.kind}: ${summary.usedProviderLabel}, model ${summary.usedModel ?? 'not reported yet'}, effort ${summary.usedEffort ?? 'provider default'}${follows}`;
    });
    const chat = await dependencies.describeChat();

    return [`chat: ${chat}`, ...lines].join('\n');
}

// The bot id is fixed when the tools are built, so a bot can only read and change its own work.
function createWorkSettingsTools(dependencies: WorkToolDependencies, botId: string): CloudbotTool[] {
    const listTool = tool(
        WORK_SETTINGS_LIST_TOOL_NAME,
        'Show the provider, model and effort your chat and each kind of work run on: web search, browsing, documents, routines, check-ins, webhooks and review. Use it when the owner asks which model or provider you use. Never guess those names.',
        {},
        async (): Promise<WorkToolResult> => {
            const text = await describeWork(dependencies, botId);

            return textResult(text);
        },
    );
    const setTool = tool(
        WORK_SETTINGS_SET_TOOL_NAME,
        'Choose the provider, model and effort of one kind of work (search, browsing, documents, routines, checkins, webhooks or review), when the owner asks for it. A null provider makes the work follow the chat. A null model or effort uses the provider default. The provider must be connected. Review runs only on claude, chatgpt or gemini. To change the chat itself, use provider_use and models_set.',
        {
            kind: z.enum(WORK_KINDS),
            provider: z.enum(PROVIDER_IDS)
                .nullable(),
            model: z.string()
                .nullable()
                .optional(),
            effort: z.string()
                .nullable()
                .optional(),
        },
        async ({ kind, provider, model, effort }): Promise<WorkToolResult> => {
            if (provider !== null) {
                const connected = await dependencies.connected();

                if (!connected.includes(provider)) {
                    return textResult(`${PROVIDER_LABELS[provider]} is not connected. Call provider_connect so the owner can sign in first.`, true);
                }
            }

            const problem = await dependencies.workSettings.save(botId, kind, { provider, model: model ?? null, effort: effort ?? null });

            if (problem !== undefined) {
                return textResult(problem, true);
            }

            const text = await describeWork(dependencies, botId);

            return textResult(`Saved. Now:\n${text}`);
        },
    );

    return [listTool, setTool] as CloudbotTool[];
}

export { WORK_SETTINGS_LIST_TOOL_FULL_NAME, WORK_SETTINGS_SET_TOOL_FULL_NAME, createWorkSettingsTools };
export type { WorkToolDependencies };
