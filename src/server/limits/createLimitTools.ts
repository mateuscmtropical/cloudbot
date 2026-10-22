import { tool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import type { TurnLimits } from '../../shared/limitTypes.ts';
import type { ToolCallVerdict } from '../approvals/ApprovalGate.ts';
import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { LimitStore } from '../store/LimitStore.ts';
import { describeLimits, isLimitInputError, parseLimitInput } from './turnLimits.ts';

interface LimitToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

const LIMITS_SET_TOOL_NAME = 'limits_set';
const LIMITS_SET_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${LIMITS_SET_TOOL_NAME}`;
const LIMITS_SET_DESCRIPTION = 'Change the limits on your turns. Pass only the fields the owner asked to change. chatMinutes, routineMinutes: the time a turn may work, in minutes, from 1 to 1440. chatUsd, routineUsd: the estimated spending per turn in US dollars, from 0.01 to 1000. The agent and the review agent are each held to the spending limit, so a turn can spend up to twice the limit. chatSteps, routineSteps: the agent steps per turn, from 1 to 1000. Pass null to remove a limit. Chat fields limit chat turns. Routine fields limit routine, webhook and watch turns. When a limit stops a turn, the owner sees which limit it was. Do it yourself when the owner asks, and do not ask follow-up questions when a sensible value works.';

const NULLABLE_NUMBER = z.number()
    .nullable()
    .optional();
const LIMITS_SET_SHAPE = {
    chatMinutes: NULLABLE_NUMBER,
    chatUsd: NULLABLE_NUMBER,
    chatSteps: NULLABLE_NUMBER,
    routineMinutes: NULLABLE_NUMBER,
    routineUsd: NULLABLE_NUMBER,
    routineSteps: NULLABLE_NUMBER,
};

interface LimitChangeArguments {
    chatMinutes?: number | null | undefined;
    chatUsd?: number | null | undefined;
    chatSteps?: number | null | undefined;
    routineMinutes?: number | null | undefined;
    routineUsd?: number | null | undefined;
    routineSteps?: number | null | undefined;
}

function textResult(text: string, isError = false): LimitToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

// A field the model did not pass keeps its stored limit. The merged payload goes through the same parser as the web route.
function mergeChanges(stored: TurnLimits, changes: LimitChangeArguments): TurnLimits {
    return {
        chat: {
            minutes: changes.chatMinutes === undefined ? stored.chat.minutes : changes.chatMinutes,
            usd: changes.chatUsd === undefined ? stored.chat.usd : changes.chatUsd,
            steps: changes.chatSteps === undefined ? stored.chat.steps : changes.chatSteps,
        },
        routines: {
            minutes: changes.routineMinutes === undefined ? stored.routines.minutes : changes.routineMinutes,
            usd: changes.routineUsd === undefined ? stored.routines.usd : changes.routineUsd,
            steps: changes.routineSteps === undefined ? stored.routines.steps : changes.routineSteps,
        },
    };
}

function formatLimit(value: number | null): string {
    return value === null ? 'none' : String(value);
}

// The card shows every limit with its old and new value, so the owner sees what the change does.
function limitCardLines(before: TurnLimits, after: TurnLimits): string[] {
    const rows: [string, number | null, number | null][] = [
        ['Chat time (minutes)', before.chat.minutes, after.chat.minutes],
        ['Chat spending (USD)', before.chat.usd, after.chat.usd],
        ['Chat steps', before.chat.steps, after.chat.steps],
        ['Routine time (minutes)', before.routines.minutes, after.routines.minutes],
        ['Routine spending (USD)', before.routines.usd, after.routines.usd],
        ['Routine steps', before.routines.steps, after.routines.steps],
    ];

    return rows.map(([label, old, next]) => `${label}: ${formatLimit(old)} -> ${formatLimit(next)}`);
}

// The approval card of limits_set. A change that the parser would refuse is refused before the owner is asked.
async function describeLimitChange(store: Pick<LimitStore, 'get'>, botId: string, input: unknown): Promise<ToolCallVerdict> {
    const stored = await store.get(botId);
    const changes: LimitChangeArguments = typeof input === 'object' && input !== null ? input : {};
    const merged = mergeChanges(stored, changes);
    const parsed = parseLimitInput(merged);

    if (isLimitInputError(parsed)) {
        return { decision: 'deny', reason: parsed.error };
    }

    const cardLines = limitCardLines(stored, parsed);
    const detail = cardLines.join('\n');

    return { decision: 'ask', summary: 'Change the limits of this bot.', detail };
}

// The bot id is fixed when the tool is built. Nothing is saved unless the merged limits are valid.
function createLimitTools(store: Pick<LimitStore, 'get' | 'set'>, botId: string): CloudbotTool[] {
    const setTool = tool(
        LIMITS_SET_TOOL_NAME,
        LIMITS_SET_DESCRIPTION,
        LIMITS_SET_SHAPE,
        async (args): Promise<LimitToolResult> => {
            const stored = await store.get(botId);
            const merged = mergeChanges(stored, args);
            const parsed = parseLimitInput(merged);

            if (isLimitInputError(parsed)) {
                return textResult(parsed.error, true);
            }

            await store.set(botId, parsed);

            return textResult(`Limits saved: ${describeLimits(parsed)}.`);
        },
    );

    return [setTool] as CloudbotTool[];
}

export { LIMITS_SET_TOOL_FULL_NAME, createLimitTools, describeLimitChange };
export type { LimitToolResult };
