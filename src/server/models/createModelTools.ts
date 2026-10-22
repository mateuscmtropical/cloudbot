import { tool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { ModelStore } from '../store/ModelStore.ts';
import type { EffortChoices, EffortFields, EffortLevel, ModelChoices } from './modelChoices.ts';
import { EFFORT_LEVELS, isModelInputError, parseEffortInput, parseModelInput } from './modelChoices.ts';

interface ModelToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

const MODELS_SET_TOOL_NAME = 'models_set';
const MODELS_SET_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${MODELS_SET_TOOL_NAME}`;
const MODELS_SET_DESCRIPTION = 'Change the models and effort the owner picked for your work. Pass only the fields the owner asked to change. chat, routines and review take a model alias (haiku, sonnet, opus or fable) or a full claude- model id. A bot on a Gemini subscription takes a Gemini model id such as gemini-3.8-flash, and its effort field picks low, medium or high. browsing and documents take the same, and they also take null for no helper. Pass null for the default model. Smaller models cost less usage. Effort is how much thinking a kind of work gets: low, medium, high, xhigh or max, and null for the default. Effort fields are chatEffort, routinesEffort, reviewEffort, browsingEffort and documentsEffort. When the owner asks for a setup change, do it yourself with this tool. If the owner names a model but no effort, pick a sensible effort yourself and say what you picked. Do not ask the owner follow-up questions when a default works.';

const MODEL_FIELD = z.string()
    .nullable()
    .optional();
const EFFORT_FIELD = z.enum(EFFORT_LEVELS)
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
    chatEffort?: EffortLevel | null | undefined;
    routinesEffort?: EffortLevel | null | undefined;
    reviewEffort?: EffortLevel | null | undefined;
    browsingEffort?: EffortLevel | null | undefined;
    documentsEffort?: EffortLevel | null | undefined;
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

function mergeEffortChanges(stored: EffortChoices, changes: ModelChangeArguments): EffortFields {
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

// The bot id is fixed when the tool is built. The merged choices go through the same parsers as the web API,
// and nothing is saved unless both parts are valid.
function createModelTools(store: Pick<ModelStore, 'get' | 'set' | 'getEfforts' | 'setEfforts'>, botId: string): CloudbotTool[] {
    const setTool = tool(
        MODELS_SET_TOOL_NAME,
        MODELS_SET_DESCRIPTION,
        MODELS_SET_SHAPE,
        async (args): Promise<ModelToolResult> => {
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
export type { ModelToolResult };
