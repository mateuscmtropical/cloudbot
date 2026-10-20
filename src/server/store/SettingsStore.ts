import { eq } from 'drizzle-orm';

import { settings } from './schema.ts';
import type { AppDatabase } from './types.ts';

class SettingsStore {
    private readonly database: AppDatabase;

    constructor(database: AppDatabase) {
        this.database = database;
    }

    async get(key: string): Promise<string | undefined> {
        const keyCondition = eq(settings.key, key);
        const rows = await this.database.select()
            .from(settings)
            .where(keyCondition);

        return rows[0]?.value;
    }

    async set(key: string, value: string): Promise<void> {
        await this.database.insert(settings)
            .values({ key, value })
            .onConflictDoUpdate({ target: settings.key, set: { value } });
    }
}

export { SettingsStore };
