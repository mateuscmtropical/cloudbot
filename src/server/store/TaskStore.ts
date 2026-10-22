import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import { isOpenStatus } from '../../shared/taskTypes.ts';
import type { TaskStatus } from '../../shared/taskTypes.ts';

import { tasks } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type TaskRecord = typeof tasks.$inferSelect;

interface MovedTask {
    task: TaskRecord;
    previousStatus: TaskStatus;
}

class TaskStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;
    // Adds with a limit run one after the other, so two calls cannot both pass the count.
    private limitedAdds: Promise<unknown> = Promise.resolve();

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async list(botId: string): Promise<TaskRecord[]> {
        const botCondition = eq(tasks.botId, botId);
        const createdOrder = asc(tasks.createdAt);

        return this.database.select()
            .from(tasks)
            .where(botCondition)
            .orderBy(createdOrder);
    }

    async add(botId: string, title: string, status: TaskStatus): Promise<TaskRecord> {
        const createdAt = this.now();
        const task = {
            id: randomUUID(),
            botId,
            channelId: null,
            title,
            status,
            blockedReason: null,
            createdAt,
            updatedAt: createdAt,
        };

        await this.database.insert(tasks)
            .values(task);

        return task;
    }

    // Returns undefined when the bot already has the limit of tasks.
    async addWithLimit(botId: string, title: string, status: TaskStatus, limit: number): Promise<TaskRecord | undefined> {
        const attempt = this.limitedAdds.then(async () => {
            const existing = await this.list(botId);
            const openTasks = existing.filter(task => isOpenStatus(task.status));

            if (openTasks.length >= limit) {
                return undefined;
            }

            return this.add(botId, title, status);
        });

        this.limitedAdds = attempt.catch(() => undefined);

        return attempt;
    }

    // Returns the task after the move and the column it was in before, or undefined when this bot has no task with the id.
    async move(botId: string, id: string, status: TaskStatus, blockedReason: string | null): Promise<MovedTask | undefined> {
        const idCondition = eq(tasks.id, id);
        const botCondition = eq(tasks.botId, botId);
        const ownCondition = and(idCondition, botCondition);
        const current = await this.database.select()
            .from(tasks)
            .where(ownCondition);
        const previous = current[0];

        if (previous === undefined) {
            return undefined;
        }

        const changes = { status, blockedReason, updatedAt: this.now() };

        const updated = await this.database.update(tasks)
            .set(changes)
            .where(ownCondition)
            .returning();

        return { task: updated[0] ?? previous, previousStatus: previous.status };
    }
}

export { TaskStore };
export type { MovedTask, TaskRecord };
