import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { ModelStore } from '../store/ModelStore.ts';
import type { ModelChoices } from './modelChoices.ts';
import { isModelInputError, parseModelInput } from './modelChoices.ts';

interface ModelToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

const MODELS_SET_TOOL_NAME = 'models_set';
const MODELS_SET_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${MODELS_SET_TOOL_NAME}`;
const MODELS_SET_DESCRIPTION = 'Change the models the owner picked for your work. Pass only the fields the owner asked to change. chat, routines and review take a model alias (haiku, sonnet, opus or fable) or a full claude- model id. browsing and documents take the same, and they also take null for no helper. Pass null for the default. Smaller models cost less usage.';

const MODEL_FIELD = z.string()
    .nullable()
    .optional();
const MODELS_SET_SHAPE = {
    chat: MODEL_FIELD,
    routines: MODEL_FIELD,
    review: MODEL_FIELD,
    browsing: MODEL_FIELD,
    documents: MODEL_FIELD,
};

interface ModelChangeArguments {
    chat?: string | null | undefined;
    routines?: string | null | undefined;
    review?: string | null | undefined;
    browsing?: string | null | undefined;
    documents?: string | null | undefined;
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

function describeChoice(value: string | null, noneText: string): string {
    return value ?? noneText;
}

function describeChoices(choices: ModelChoices): string {
    return [
        `chat ${describeChoice(choices.chat, 'default')}`,
        `routines ${describeChoice(choices.routines, 'default')}`,
        `review ${describeChoice(choices.review, 'default')}`,
        `browsing ${describeChoice(choices.browsing, 'no helper')}`,
        `documents ${describeChoice(choices.documents, 'no helper')}`,
    ].join(', ');
}

// The bot id is fixed when the tool is built. The merged choices go through the same parser as the web API.
function createModelTools(store: Pick<ModelStore, 'get' | 'set'>, botId: string): CloudbotTool[] {
    const setTool = tool(
        MODELS_SET_TOOL_NAME,
        MODELS_SET_DESCRIPTION,
        MODELS_SET_SHAPE,
        async (args): Promise<ModelToolResult> => {
            const stored = await store.get(botId);
            const merged = mergeChanges(stored, args);
            const parsed = parseModelInput(merged);

            if (isModelInputError(parsed)) {
                return textResult(parsed.error, true);
            }

            await store.set(botId, parsed);

            return textResult(`Models saved: ${describeChoices(parsed)}.`);
        },
    );

    return [setTool] as CloudbotTool[];
}

export { MODELS_SET_TOOL_FULL_NAME, createModelTools };
export type { ModelToolResult };
