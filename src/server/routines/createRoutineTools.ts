import { tool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { RoutineStore } from '../store/RoutineStore.ts';
import { MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, parseSchedule } from './schedule.ts';

interface RoutineToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

const ROUTINE_CREATE_TOOL_NAME = 'routine_create';
const ROUTINE_LIST_TOOL_NAME = 'routine_list';
const ROUTINE_DELETE_TOOL_NAME = 'routine_delete';
const ROUTINE_SET_ENABLED_TOOL_NAME = 'routine_set_enabled';
const ROUTINE_CREATE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${ROUTINE_CREATE_TOOL_NAME}`;
const ROUTINE_LIST_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${ROUTINE_LIST_TOOL_NAME}`;
const ROUTINE_DELETE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${ROUTINE_DELETE_TOOL_NAME}`;
const ROUTINE_SET_ENABLED_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${ROUTINE_SET_ENABLED_TOOL_NAME}`;
const ROUTINE_TOOL_FULL_NAMES = [
    ROUTINE_CREATE_TOOL_FULL_NAME,
    ROUTINE_LIST_TOOL_FULL_NAME,
    ROUTINE_DELETE_TOOL_FULL_NAME,
    ROUTINE_SET_ENABLED_TOOL_FULL_NAME,
];

const MAX_ROUTINES_PER_BOT = 20;
const MAX_NAME_LENGTH = 60;
const MAX_PROMPT_LENGTH = 2000;

const CREATE_DESCRIPTION = `Create a routine: a prompt that is sent to you on a schedule, as a chat message. Use it only when the owner asks for something to repeat. The schedule is one of: {kind:"interval", everyMinutes} (${String(MIN_INTERVAL_MINUTES)} to ${String(MAX_INTERVAL_MINUTES)}), {kind:"daily", hour, minute} or {kind:"weekly", weekday, hour, minute} with weekday 0 for Sunday to 6 for Saturday. Hours and minutes are UTC. Write the prompt so you can do the task without the current chat. Set isQuiet true for a check-in that should message the owner only when something needs them. A quiet run that finds nothing leaves no trace in the chat, and it runs on a small model unless the owner picked one for routines. Leave isQuiet off for a brief or anything the owner wants to read every time.`;
const LIST_DESCRIPTION = 'List your routines with their ids, schedules and next run times (UTC).';
const DELETE_DESCRIPTION = 'Delete one of your routines by id.';
const SET_ENABLED_DESCRIPTION = 'Turn one of your routines on or off by id. A routine that is off does not run.';

const CREATE_SHAPE = {
    name: z.string()
        .trim()
        .min(1)
        .max(MAX_NAME_LENGTH),
    prompt: z.string()
        .trim()
        .min(1)
        .max(MAX_PROMPT_LENGTH),
    isQuiet: z.boolean()
        .optional(),
    // Strict, so a wrong key such as hours is refused by name before the review.
    schedule: z.strictObject({
        kind: z.enum(['interval', 'daily', 'weekly']),
        everyMinutes: z.number()
            .optional(),
        weekday: z.number()
            .optional(),
        hour: z.number()
            .optional(),
        minute: z.number()
            .optional(),
    }),
};
const LIST_SHAPE = {};
const ID_SHAPE = { id: z.string() };
const SET_ENABLED_SHAPE = { id: z.string(), isEnabled: z.boolean() };

function textResult(text: string, isError = false): RoutineToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function formatTime(timeMs: number): string {
    return new Date(timeMs)
        .toISOString();
}

function createRoutineTools(store: RoutineStore, botId: string): CloudbotTool[] {
    const createTool = tool(
        ROUTINE_CREATE_TOOL_NAME,
        CREATE_DESCRIPTION,
        CREATE_SHAPE,
        async (args): Promise<RoutineToolResult> => {
            const schedule = parseSchedule(args.schedule);

            if (schedule === undefined) {
                return textResult(`The schedule is not valid. An interval is ${String(MIN_INTERVAL_MINUTES)} to ${String(MAX_INTERVAL_MINUTES)} minutes. Hours are 0 to 23, minutes 0 to 59 and weekdays 0 to 6.`, true);
            }

            const routine = await store.addWithLimit(botId, { name: args.name, prompt: args.prompt, schedule, isQuiet: args.isQuiet === true }, MAX_ROUTINES_PER_BOT);

            if (routine === undefined) {
                return textResult(`You can have at most ${String(MAX_ROUTINES_PER_BOT)} routines. Delete one first.`, true);
            }

            return textResult(`Routine created with id ${routine.id}. The first run is at ${formatTime(routine.nextRunAt)} UTC.`);
        },
    );
    const listTool = tool(
        ROUTINE_LIST_TOOL_NAME,
        LIST_DESCRIPTION,
        LIST_SHAPE,
        async (): Promise<RoutineToolResult> => {
            const routines = await store.list(botId);

            if (routines.length === 0) {
                return textResult('You have no routines.');
            }

            const lines = routines.map((routine) => {
                const state = routine.isEnabled ? `next run ${formatTime(routine.nextRunAt)} UTC` : 'off';
                const scheduleText = JSON.stringify(routine.schedule);

                const kindText = routine.isQuiet ? ' (quiet check-in)' : '';

                return `- ${routine.id}: "${routine.name}"${kindText} ${scheduleText}, ${state}`;
            });

            const listText = lines.join('\n');

            return textResult(listText);
        },
    );
    const deleteTool = tool(
        ROUTINE_DELETE_TOOL_NAME,
        DELETE_DESCRIPTION,
        ID_SHAPE,
        async (args): Promise<RoutineToolResult> => {
            const isRemoved = await store.remove(botId, args.id);

            return isRemoved ? textResult('The routine is deleted.') : textResult('You have no routine with this id.', true);
        },
    );
    const setEnabledTool = tool(
        ROUTINE_SET_ENABLED_TOOL_NAME,
        SET_ENABLED_DESCRIPTION,
        SET_ENABLED_SHAPE,
        async (args): Promise<RoutineToolResult> => {
            const isChanged = await store.setEnabled(botId, args.id, args.isEnabled);

            if (!isChanged) {
                return textResult('You have no routine with this id.', true);
            }

            return textResult(args.isEnabled ? 'The routine is on.' : 'The routine is off.');
        },
    );

    return [createTool, listTool, deleteTool, setEnabledTool] as CloudbotTool[];
}

export {
    MAX_ROUTINES_PER_BOT,
    ROUTINE_LIST_TOOL_FULL_NAME,
    ROUTINE_TOOL_FULL_NAMES,
    createRoutineTools,
};
export type { RoutineToolResult };
