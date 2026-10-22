import { tool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { TaskRecord, TaskStore } from '../store/TaskStore.ts';
import { TASK_BLOCKED_NOTICE_PREFIX, TASK_LABELS, TASK_STATUSES, isOpenStatus } from '../../shared/taskTypes.ts';
import type { TaskCard } from '../../shared/taskTypes.ts';

interface TaskToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

interface TaskToolHandlers {
    // Called after a task moves into Blocked from another column. A failure is reported to the bot, the move stays.
    onBlocked: (task: TaskCard) => Promise<void>;
    // Called with the cards to show, at most BOARD_CARD_LIMIT, and how many tasks did not fit.
    onBoard: (cards: TaskCard[], hiddenCount: number) => Promise<void>;
}

const TASK_ADD_TOOL_NAME = 'task_add';
const TASK_MOVE_TOOL_NAME = 'task_move';
const TASK_BOARD_TOOL_NAME = 'task_board';
const TASK_ADD_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${TASK_ADD_TOOL_NAME}`;
const TASK_MOVE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${TASK_MOVE_TOOL_NAME}`;
const TASK_BOARD_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${TASK_BOARD_TOOL_NAME}`;
const TASK_TOOL_FULL_NAMES = [TASK_ADD_TOOL_FULL_NAME, TASK_MOVE_TOOL_FULL_NAME, TASK_BOARD_TOOL_FULL_NAME];

const MAX_TASKS_PER_BOT = 100;
const BOARD_CARD_LIMIT = 50;
const MAX_TITLE_LENGTH = 120;
const MAX_REASON_LENGTH = 500;

const ADD_DESCRIPTION = 'Add a task to your board. Use it when the owner asks you to keep track of something. New tasks start in To do unless you give another column, except Blocked, which needs task_move with a reason.';
const MOVE_DESCRIPTION = 'Move one of your tasks to a column by id. Moving to Blocked needs a reason in plain words, and the owner is told in the chat. Moving out of Blocked clears the reason.';
const BOARD_DESCRIPTION = 'Show your task board in the chat as a card, with each task and its id. Use it when the owner asks to see the tasks. The card is a snapshot, so call it again after changes.';

// Titles and reasons are shown in the chat and in the prompt, so control and hidden characters are refused.
const CONTROL_OR_HIDDEN_PATTERN = /[\p{Cc}\p{Cf}]/u;
const PLAIN_TEXT_MESSAGE = 'Use plain text, without line breaks or hidden characters.';

const ADD_SHAPE = {
    title: z.string()
        .trim()
        .min(1)
        .max(MAX_TITLE_LENGTH)
        .refine(value => !CONTROL_OR_HIDDEN_PATTERN.test(value), PLAIN_TEXT_MESSAGE),
    status: z.enum(TASK_STATUSES)
        .exclude(['blocked'])
        .optional(),
};
const MOVE_SHAPE = {
    id: z.string(),
    status: z.enum(TASK_STATUSES),
    reason: z.string()
        .trim()
        .max(MAX_REASON_LENGTH)
        .refine(value => !CONTROL_OR_HIDDEN_PATTERN.test(value), PLAIN_TEXT_MESSAGE)
        .optional(),
};
const BOARD_SHAPE = {};

// Markdown and HTML characters are escaped, so the notice shows the title and reason as typed, with no link.
const MARKDOWN_SPECIAL_PATTERN = /[\\`*_{}[\]()#+\-.!|<>~:&]/g;

function escapeMarkdown(text: string): string {
    return text.replace(MARKDOWN_SPECIAL_PATTERN, '\\$&');
}

// The chat line for a task that just became blocked. The bot wrote it, so it has the bot's prefix.
function describeBlockedNotice(task: TaskCard): string {
    const titleJson = JSON.stringify(task.title);
    const reasonJson = JSON.stringify(task.blockedReason ?? '');
    const quotedTitle = escapeMarkdown(titleJson);
    const quotedReason = escapeMarkdown(reasonJson);

    return `${TASK_BLOCKED_NOTICE_PREFIX}${quotedTitle}. Reason: ${quotedReason}`;
}

function textResult(text: string, isError = false): TaskToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

// Open tasks first, newest first. Done tasks come last, also newest first.
function boardOrder(records: TaskRecord[]): TaskRecord[] {
    const newestFirst = [...records].sort((first, second) => second.createdAt - first.createdAt);
    const openFirst = newestFirst.filter(task => isOpenStatus(task.status));
    const doneLast = newestFirst.filter(task => !isOpenStatus(task.status));

    return [...openFirst, ...doneLast];
}

function toCard(task: TaskRecord): TaskCard {
    return { id: task.id, title: task.title, status: task.status, blockedReason: task.blockedReason };
}

function describeBoard(cards: TaskCard[], hiddenCount: number): string {
    if (cards.length === 0) {
        return 'Your board has no tasks.';
    }

    const lines = cards.map((card) => {
        const reason = card.blockedReason === null ? '' : ` (${card.blockedReason})`;

        return `- ${card.id}: ${card.title}, ${TASK_LABELS[card.status]}${reason}`;
    });

    if (hiddenCount > 0) {
        lines.push(`and ${String(hiddenCount)} more`);
    }

    return lines.join('\n');
}

function createTaskTools(store: TaskStore, botId: string, handlers: TaskToolHandlers): CloudbotTool[] {
    const addTool = tool(
        TASK_ADD_TOOL_NAME,
        ADD_DESCRIPTION,
        ADD_SHAPE,
        async (args): Promise<TaskToolResult> => {
            const task = await store.addWithLimit(botId, args.title, args.status ?? 'todo', MAX_TASKS_PER_BOT);

            if (task === undefined) {
                return textResult(`Your board has ${String(MAX_TASKS_PER_BOT)} open tasks. Finish one before you add more.`, true);
            }

            return textResult(`Task added with id ${task.id}.`);
        },
    );
    const moveTool = tool(
        TASK_MOVE_TOOL_NAME,
        MOVE_DESCRIPTION,
        MOVE_SHAPE,
        async (args): Promise<TaskToolResult> => {
            const reason = args.reason ?? '';

            if (args.status === 'blocked' && reason === '') {
                return textResult('Say why the task is blocked. Pass a reason.', true);
            }

            const moved = await store.move(botId, args.id, args.status, args.status === 'blocked' ? reason : null);

            if (moved === undefined) {
                return textResult('You have no task with this id.', true);
            }

            const isNewlyBlocked = moved.task.status === 'blocked' && moved.previousStatus !== 'blocked';

            if (!isNewlyBlocked) {
                return textResult(`The task is ${TASK_LABELS[moved.task.status]}.`);
            }

            const card = toCard(moved.task);

            try {
                await handlers.onBlocked(card);
            } catch {
                return textResult('The task is Blocked, but the notice in the chat failed. Tell the owner the reason in your reply.');
            }

            return textResult('The task is Blocked. The owner is told in the chat.');
        },
    );
    const boardTool = tool(
        TASK_BOARD_TOOL_NAME,
        BOARD_DESCRIPTION,
        BOARD_SHAPE,
        async (): Promise<TaskToolResult> => {
            const records = await store.list(botId);
            const cards = boardOrder(records)
                .map(toCard);
            const shownCards = cards.slice(0, BOARD_CARD_LIMIT);
            const hiddenCount = cards.length - shownCards.length;

            await handlers.onBoard(shownCards, hiddenCount);

            const board = describeBoard(shownCards, hiddenCount);

            return textResult(board);
        },
    );

    return [addTool, moveTool, boardTool] as CloudbotTool[];
}

export {
    ADD_SHAPE,
    BOARD_CARD_LIMIT,
    MAX_TASKS_PER_BOT,
    MOVE_SHAPE,
    TASK_ADD_TOOL_FULL_NAME,
    TASK_BOARD_TOOL_FULL_NAME,
    TASK_MOVE_TOOL_FULL_NAME,
    TASK_TOOL_FULL_NAMES,
    createTaskTools,
    describeBlockedNotice,
    describeBoard,
    escapeMarkdown,
};
export type { TaskToolHandlers };
