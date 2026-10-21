import { randomUUID } from 'node:crypto';

import { and, asc, eq, or } from 'drizzle-orm';

import { browserAllowedHosts } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type BrowserAllowRecord = typeof browserAllowedHosts.$inferSelect;

// Port 0 in the table allows every port of the host.
const ANY_PORT = 0;

// The hosts the owner allowed the browser to reach. The host must already be normalized.
class BrowserAllowStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async list(): Promise<BrowserAllowRecord[]> {
        const createdOrder = asc(browserAllowedHosts.createdAt);

        return this.database.select()
            .from(browserAllowedHosts)
            .orderBy(createdOrder);
    }

    // Adding a host that is already allowed keeps the first row.
    async add(host: string, port: number | undefined): Promise<BrowserAllowRecord> {
        const storedPort = port ?? ANY_PORT;
        const newRow = {
            id: randomUUID(),
            host,
            port: storedPort,
            createdAt: this.now(),
        };

        await this.database.insert(browserAllowedHosts)
            .values(newRow)
            .onConflictDoNothing();

        const hostCondition = eq(browserAllowedHosts.host, host);
        const portCondition = eq(browserAllowedHosts.port, storedPort);
        const rowCondition = and(hostCondition, portCondition);
        const foundRows = await this.database.select()
            .from(browserAllowedHosts)
            .where(rowCondition);
        const foundRow = foundRows[0];

        if (foundRow === undefined) {
            throw new Error('The allowed host could not be read back.');
        }

        return foundRow;
    }

    // Returns false when no row has the id.
    async remove(id: string): Promise<boolean> {
        const idCondition = eq(browserAllowedHosts.id, id);
        const removedRows = await this.database.delete(browserAllowedHosts)
            .where(idCondition)
            .returning();

        return removedRows.length > 0;
    }

    // A row for the port or for every port of the host allows the connection.
    async isAllowed(host: string, port: number): Promise<boolean> {
        const hostCondition = eq(browserAllowedHosts.host, host);
        const anyPortCondition = eq(browserAllowedHosts.port, ANY_PORT);
        const exactPortCondition = eq(browserAllowedHosts.port, port);
        const portCondition = or(anyPortCondition, exactPortCondition);
        const rowCondition = and(hostCondition, portCondition);
        const foundRows = await this.database.select()
            .from(browserAllowedHosts)
            .where(rowCondition)
            .limit(1);

        return foundRows.length > 0;
    }
}

export { BrowserAllowStore };
export type { BrowserAllowRecord };
