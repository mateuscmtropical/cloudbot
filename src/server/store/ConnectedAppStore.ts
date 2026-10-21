import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import type { ConnectedAppStatus } from '../../shared/connectedApps.ts';
import { connectedApps } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type ConnectedAppRecord = typeof connectedApps.$inferSelect;

interface ConnectedAppInput {
    name: string;
    url: string;
    status: ConnectedAppStatus;
    toolCount: number;
    problem: string | undefined;
    secretName: string | undefined;
    secretBotId: string | undefined;
}

// The remote MCP servers the owner connected. A server is kept by its name, so connecting it again replaces the row.
class ConnectedAppStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async list(): Promise<ConnectedAppRecord[]> {
        const createdOrder = asc(connectedApps.createdAt);

        return this.database.select()
            .from(connectedApps)
            .orderBy(createdOrder);
    }

    async findById(id: string): Promise<ConnectedAppRecord | undefined> {
        const idCondition = eq(connectedApps.id, id);
        const rows = await this.database.select()
            .from(connectedApps)
            .where(idCondition);

        return rows[0];
    }

    async findByName(name: string): Promise<ConnectedAppRecord | undefined> {
        const nameCondition = eq(connectedApps.name, name);
        const rows = await this.database.select()
            .from(connectedApps)
            .where(nameCondition);

        return rows[0];
    }

    async save(input: ConnectedAppInput): Promise<ConnectedAppRecord> {
        const existing = await this.findByName(input.name);
        const values = {
            url: input.url,
            status: input.status,
            toolCount: input.toolCount,
            problem: input.problem ?? null,
            secretName: input.secretName ?? null,
            secretBotId: input.secretBotId ?? null,
        };

        if (existing === undefined) {
            const id = randomUUID();

            await this.database.insert(connectedApps)
                .values({ id, name: input.name, createdAt: this.now(), ...values });
        } else {
            const existingCondition = eq(connectedApps.id, existing.id);

            await this.database.update(connectedApps)
                .set(values)
                .where(existingCondition);
        }

        const saved = await this.findByName(input.name);

        if (saved === undefined) {
            throw new Error('The connected app could not be read back.');
        }

        return saved;
    }

    // True when a row still points at this vault secret. A secret that no row uses can be deleted.
    async isSecretInUse(secretBotId: string, secretName: string): Promise<boolean> {
        const botCondition = eq(connectedApps.secretBotId, secretBotId);
        const nameCondition = eq(connectedApps.secretName, secretName);
        const secretCondition = and(botCondition, nameCondition);
        const rows = await this.database.select()
            .from(connectedApps)
            .where(secretCondition)
            .limit(1);

        return rows.length > 0;
    }

    // Returns false when no row has the id.
    async remove(id: string): Promise<boolean> {
        const existing = await this.findById(id);

        if (existing === undefined) {
            return false;
        }

        const idCondition = eq(connectedApps.id, id);

        await this.database.delete(connectedApps)
            .where(idCondition);

        return true;
    }
}

export { ConnectedAppStore };
export type { ConnectedAppInput, ConnectedAppRecord };
