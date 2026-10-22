// The columns of the task board, in the order the owner reads them.
const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;

type TaskStatus = (typeof TASK_STATUSES)[number];

// One card as the chat shows it. The blocked reason is set only while the task is blocked.
interface TaskCard {
    id: string;
    title: string;
    status: TaskStatus;
    blockedReason: string | null;
}

// The column names the owner sees.
const TASK_LABELS: Record<TaskStatus, string> = {
    todo: 'To do',
    doing: 'Doing',
    blocked: 'Blocked',
    done: 'Done',
};

// A task still to do counts toward the board limit and shows before Done tasks on the board.
function isOpenStatus(status: TaskStatus): boolean {
    return status !== 'done';
}

// The chat line for a blocked task starts with this. The bot wrote the line, so the review card labels it as the bot's.
const TASK_BLOCKED_NOTICE_PREFIX = 'Task blocked by this bot: ';

export { TASK_BLOCKED_NOTICE_PREFIX, TASK_LABELS, TASK_STATUSES, isOpenStatus };
export type { TaskCard, TaskStatus };
