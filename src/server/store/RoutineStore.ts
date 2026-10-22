import { randomUUID } from 'node:crypto';

import { and, asc, eq, lte } from 'drizzle-orm';

import { computeNextRun } from '../routines/schedule.ts';
import type { RoutineSchedule } from '../routines/schedule.ts';

import { routines } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type RoutineRecord = typeof routines.$inferSelect;

interface NewRoutine {
    name: string;
    prompt: string;
    schedule: RoutineSchedule;
    isQuiet?: boolean;
}

class RoutineStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;
    // Adds with a limit run one after the other, so two calls cannot both pass the count.
    private limitedAdds: Promise<unknown> = Promise.resolve();

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async list(botId: string): Promise<RoutineRecord[]> {
        const botCondition = eq(routines.botId, botId);
        const createdOrder = asc(routines.createdAt);

        return this.database.select()
            .from(routines)
            .where(botCondition)
            .orderBy(createdOrder);
    }

    async add(botId: string, routine: NewRoutine): Promise<RoutineRecord> {
        const createdAt = this.now();
        const newRoutine = {
            id: randomUUID(),
            botId,
            ...routine,
            isQuiet: routine.isQuiet ?? false,
            isEnabled: true,
            nextRunAt: computeNextRun(routine.schedule, createdAt),
            lastRunAt: null,
            createdAt,
        };
        const insertedRows = await this.database.insert(routines)
            .values(newRoutine)
            .returning();
        const insertedRoutine = insertedRows[0];

        if (insertedRoutine === undefined) {
            throw new Error('Inserting a routine returned no row');
        }

        return insertedRoutine;
    }

    // Returns undefined when the bot already has `maxRoutines` routines.
    async addWithLimit(botId: string, routine: NewRoutine, maxRoutines: number): Promise<RoutineRecord | undefined> {
        const addIfRoom = async (): Promise<RoutineRecord | undefined> => {
            const existingRoutines = await this.list(botId);

            return existingRoutines.length >= maxRoutines ? undefined : this.add(botId, routine);
        };
        // A failed add must not block the adds queued behind it.
        const result = this.limitedAdds.then(addIfRoom, addIfRoom);

        this.limitedAdds = result;

        return result;
    }

    // Returns false when the bot has no routine with this id.
    async remove(botId: string, routineId: string): Promise<boolean> {
        const botCondition = eq(routines.botId, botId);
        const idCondition = eq(routines.id, routineId);
        const routineCondition = and(botCondition, idCondition);
        const removedRows = await this.database.delete(routines)
            .where(routineCondition)
            .returning();

        return removedRows.length > 0;
    }

    // Turning a routine on starts its schedule from now, so it does not fire for time it was off.
    async setEnabled(botId: string, routineId: string, isEnabled: boolean): Promise<boolean> {
        const routine = await this.find(botId, routineId);

        if (routine === undefined) {
            return false;
        }

        const idCondition = eq(routines.id, routineId);

        if (routine.isEnabled || !isEnabled) {
            await this.database.update(routines)
                .set({ isEnabled })
                .where(idCondition);

            return true;
        }

        const nowMs = this.now();
        const nextRunAt = computeNextRun(routine.schedule, nowMs);

        await this.database.update(routines)
            .set({ isEnabled, nextRunAt })
            .where(idCondition);

        return true;
    }

    // Enabled routines whose time has come, oldest due time first.
    async listDue(nowMs: number): Promise<RoutineRecord[]> {
        const enabledCondition = eq(routines.isEnabled, true);
        const dueCondition = lte(routines.nextRunAt, nowMs);
        const enabledAndDue = and(enabledCondition, dueCondition);
        const dueOrder = asc(routines.nextRunAt);

        return this.database.select()
            .from(routines)
            .where(enabledAndDue)
            .orderBy(dueOrder);
    }

    // Moves the next run past `nowMs`, so a missed slot runs once and a routine never repeats on a restart.
    async markRun(routine: RoutineRecord, nowMs: number): Promise<void> {
        const nextRunAt = computeNextRun(routine.schedule, nowMs);
        const idCondition = eq(routines.id, routine.id);

        await this.database.update(routines)
            .set({ lastRunAt: nowMs, nextRunAt })
            .where(idCondition);
    }

    private async find(botId: string, routineId: string): Promise<RoutineRecord | undefined> {
        const botCondition = eq(routines.botId, botId);
        const idCondition = eq(routines.id, routineId);
        const routineCondition = and(botCondition, idCondition);
        const foundRows = await this.database.select()
            .from(routines)
            .where(routineCondition);

        return foundRows[0];
    }
}

export { RoutineStore };
export type { NewRoutine, RoutineRecord };
