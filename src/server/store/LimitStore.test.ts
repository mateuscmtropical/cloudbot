import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TurnLimits } from '../../shared/limitTypes.ts';
import { BotStore } from './BotStore.ts';
import { LimitStore } from './LimitStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';

describe('LimitStore', () => {
    let opened: OpenedDatabase;
    let store: LimitStore;
    let botId: string;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new LimitStore(opened.db);

        const botStore = new BotStore(opened.db);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        botId = bot.id;
    });

    afterEach(() => {
        opened.close();
    });

    it('has no limits for a bot that never set any', async () => {
        expect(await store.get(botId))
            .toEqual({
                chat: { minutes: null, usd: null, steps: null },
                routines: { minutes: null, usd: null, steps: null },
            });
    });

    it('keeps the limits it is given, and a second set replaces them', async () => {
        const first: TurnLimits = {
            chat: { minutes: 15, usd: 2.25, steps: 30 },
            routines: { minutes: null, usd: 0.5, steps: null },
        };
        const second: TurnLimits = {
            chat: { minutes: null, usd: null, steps: 8 },
            routines: { minutes: 90, usd: null, steps: null },
        };

        await store.set(botId, first);
        expect(await store.get(botId))
            .toEqual(first);

        await store.set(botId, second);
        expect(await store.get(botId))
            .toEqual(second);
    });
});
