import { tool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { ModelStore } from '../store/ModelStore.ts';
import type { EffortChoices, EffortLevel, ModelChoices } from './modelChoices.ts';
import { isModelInputError, parseEffortInput, parseModelInput } from './modelChoices.ts';
import type { ProviderId } from '../providers/providerIds.ts';
import type { ProviderModelCatalog, ProviderModelCatalogs } from '../providers/ProviderModelCatalogs.ts';

interface ModelToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

const MODELS_SET_TOOL_NAME = 'models_set';
const MODELS_SET_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${MODELS_SET_TOOL_NAME}`;
const MODELS_SET_DESCRIPTION = 'Change the model and effort the owner picked for your work. Pass only the fields the owner asked to change. On Claude, chat, routines and review take a model alias (haiku, sonnet, opus or fable) or a full claude- model id. browsing and documents take the same, and they also take null for no helper. Pass null for the default model. Claude effort fields take low, medium, high, xhigh or max, and null for the default. On another provider, chat takes one exact model ID from that provider\'s advertised model list, and chatEffort takes one effort advertised for the selected model. A provider with no advertised models keeps its default. When the owner changes a model without naming an effort, keep a saved effort if that model offers it, and otherwise use the provider default effort. Do not ask the owner follow-up questions when a default works.';

const MODEL_FIELD = z.string()
    .nullable()
    .optional();
const EFFORT_FIELD = z.string()
    .nullable()
    .optional();
const MODELS_SET_SHAPE = {
    chat: MODEL_FIELD,
    routines: MODEL_FIELD,
    review: MODEL_FIELD,
    browsing: MODEL_FIELD,
    documents: MODEL_FIELD,
    chatEffort: EFFORT_FIELD,
    routinesEffort: EFFORT_FIELD,
    reviewEffort: EFFORT_FIELD,
    browsingEffort: EFFORT_FIELD,
    documentsEffort: EFFORT_FIELD,
};

interface ModelChangeArguments {
    chat?: string | null | undefined;
    routines?: string | null | undefined;
    review?: string | null | undefined;
    browsing?: string | null | undefined;
    documents?: string | null | undefined;
    chatEffort?: string | null | undefined;
    routinesEffort?: string | null | undefined;
    reviewEffort?: string | null | undefined;
    browsingEffort?: string | null | undefined;
    documentsEffort?: string | null | undefined;
}

interface EffortInputFields {
    chatEffort: string | null;
    routinesEffort: string | null;
    reviewEffort: string | null;
    browsingEffort: string | null;
    documentsEffort: string | null;
}

interface ModelToolStore extends Pick<ModelStore, 'get' | 'set' | 'getEfforts' | 'setEfforts'> {
    getProviderChoice?: ModelStore['getProviderChoice'];
    setProviderChoice?: ModelStore['setProviderChoice'];
}

interface ModelToolOptions {
    providerFor?: (() => Promise<ProviderId>) | undefined;
    modelCatalogs?: ProviderModelCatalogs | undefined;
}

function textResult(text: string, isError = false): ModelToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

// A field the model did not pass keeps its stored choice.
function mergeChanges(stored: ModelChoices, changes: ModelChangeArguments): ModelChoices {
    return {
        chat: changes.chat === undefined ? stored.chat : changes.chat,
        routines: changes.routines === undefined ? stored.routines : changes.routines,
        review: changes.review === undefined ? stored.review : changes.review,
        browsing: changes.browsing === undefined ? stored.browsing : changes.browsing,
        documents: changes.documents === undefined ? stored.documents : changes.documents,
    };
}

function mergeEffortChanges(stored: EffortChoices, changes: ModelChangeArguments): EffortInputFields {
    return {
        chatEffort: changes.chatEffort === undefined ? stored.chat : changes.chatEffort,
        routinesEffort: changes.routinesEffort === undefined ? stored.routines : changes.routinesEffort,
        reviewEffort: changes.reviewEffort === undefined ? stored.review : changes.reviewEffort,
        browsingEffort: changes.browsingEffort === undefined ? stored.browsing : changes.browsingEffort,
        documentsEffort: changes.documentsEffort === undefined ? stored.documents : changes.documentsEffort,
    };
}

function describeKind(model: string | null, effort: EffortLevel | null, noneText: string): string {
    const modelText = model ?? noneText;
    const effortText = effort ?? 'default effort';

    return `${modelText} (${effortText})`;
}

function describeChoices(choices: ModelChoices, efforts: EffortChoices): string {
    return [
        `chat ${describeKind(choices.chat, efforts.chat, 'default model')}`,
        `routines ${describeKind(choices.routines, efforts.routines, 'default model')}`,
        `review ${describeKind(choices.review, efforts.review, 'default model')}`,
        `browsing ${describeKind(choices.browsing, efforts.browsing, 'no helper')}`,
        `documents ${describeKind(choices.documents, efforts.documents, 'no helper')}`,
    ].join(', ');
}

function hasUnsupportedProviderFields(changes: ModelChangeArguments): boolean {
    return changes.routines !== undefined || changes.review !== undefined || changes.browsing !== undefined || changes.documents !== undefined
        || changes.routinesEffort !== undefined || changes.reviewEffort !== undefined || changes.browsingEffort !== undefined || changes.documentsEffort !== undefined;
}

function describeProviderModel(modelId: string | null, catalog: ProviderModelCatalog): string {
    if (modelId === null) {
        return catalog.defaultModel ?? 'provider default';
    }

    return catalog.models.find(model => model.id === modelId)?.label ?? modelId;
}

async function setProviderModelChoice(store: ModelToolStore, botId: string, provider: ProviderId, catalog: ProviderModelCatalog | undefined, changes: ModelChangeArguments): Promise<ModelToolResult> {
    if (catalog === undefined || catalog.models.length === 0) {
        return textResult(`${provider} does not advertise selectable models, so its default stays in use.`, true);
    }

    if (store.getProviderChoice === undefined || store.setProviderChoice === undefined) {
        return textResult('Provider model settings are not available.', true);
    }

    if (hasUnsupportedProviderFields(changes)) {
        return textResult(`On ${provider}, models_set accepts chat and chatEffort only.`, true);
    }

    const stored = await store.getProviderChoice(botId, provider);
    const modelId = changes.chat === undefined ? stored?.model ?? null : changes.chat;
    const requestedEffort = changes.chatEffort === undefined ? stored?.effort ?? null : changes.chatEffort;
    const storedDefaultIsOffered = stored?.defaultModel !== null && stored?.defaultModel !== undefined
        && catalog.models.some(option => option.id === stored.defaultModel);
    const defaultModel = storedDefaultIsOffered ? stored.defaultModel : catalog.defaultModel;
    const selectedModelId = modelId ?? defaultModel;
    const model = catalog.models.find(option => option.id === selectedModelId);

    if (modelId !== null && model === undefined) {
        return textResult(`The ${provider} model must match an ID in its advertised model list.`, true);
    }

    const effort = requestedEffort !== null && model?.efforts.includes(requestedEffort) !== true
        ? changes.chat !== undefined && changes.chatEffort === undefined ? null : requestedEffort
        : requestedEffort;

    if (effort !== null && model?.efforts.includes(effort) !== true) {
        return textResult(`The ${provider} effort must match an effort advertised for the selected model.`, true);
    }

    const defaultEffort = [model?.defaultEffort, stored?.defaultEffort, catalog.defaultEffort]
        .find(candidate => candidate !== null && candidate !== undefined && model?.efforts.includes(candidate)) ?? null;

    await store.setProviderChoice(botId, provider, {
        model: modelId,
        effort,
        defaultModel,
        defaultEffort,
    });

    return textResult(`Models saved for ${provider}: ${describeProviderModel(selectedModelId, catalog)} (${effort ?? 'default effort'}).`);
}

// The bot id is fixed when the tool is built. The merged choices go through the same parsers as the web API,
// and nothing is saved unless both parts are valid.
function createModelTools(store: ModelToolStore, botId: string, options: ModelToolOptions = {}): CloudbotTool[] {
    const setTool = tool(
        MODELS_SET_TOOL_NAME,
        MODELS_SET_DESCRIPTION,
        MODELS_SET_SHAPE,
        async (args): Promise<ModelToolResult> => {
            const provider = await options.providerFor?.() ?? 'claude';

            if (provider !== 'claude') {
                return setProviderModelChoice(store, botId, provider, options.modelCatalogs?.get(provider), args);
            }

            const storedModels = await store.get(botId);
            const storedEfforts = await store.getEfforts(botId);
            const mergedModels = mergeChanges(storedModels, args);
            const parsedModels = parseModelInput(mergedModels);

            if (isModelInputError(parsedModels)) {
                return textResult(parsedModels.error, true);
            }

            const mergedEfforts = mergeEffortChanges(storedEfforts, args);
            const parsedEfforts = parseEffortInput(mergedEfforts);

            if (isModelInputError(parsedEfforts)) {
                return textResult(parsedEfforts.error, true);
            }

            await store.set(botId, parsedModels);
            await store.setEfforts(botId, parsedEfforts);

            return textResult(`Models saved: ${describeChoices(parsedModels, parsedEfforts)}.`);
        },
    );

    return [setTool] as CloudbotTool[];
}

export { MODELS_SET_TOOL_FULL_NAME, createModelTools };
export type { ModelToolOptions, ModelToolResult, ModelToolStore };
