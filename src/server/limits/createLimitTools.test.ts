import { describe, expect, it } from 'vitest';

import type { TurnLimits } from '../../shared/limitTypes.ts';
import type { LimitStore } from '../store/LimitStore.ts';
import { createLimitTools } from './createLimitTools.ts';
import type { LimitToolResult } from './createLimitTools.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<LimitToolResult>;

const NO_LIMITS: TurnLimits = {
    chat: { minutes: null, usd: null, steps: null },
    routines: { minutes: null, usd: null, steps: null },
};

// An in-memory store. The tool only uses get and set.
function createFakeStore(initial: TurnLimits): { store: Pick<LimitStore, 'get' | 'set'>; saved: TurnLimits[] } {
    const saved: TurnLimits[] = [];
    let current = initial;
    const store: Pick<LimitStore, 'get' | 'set'> = {
        get: () => Promise.resolve(current),
        set: (_botId, limits) => {
            current = limits;
            saved.push(limits);

            return Promise.resolve();
        },
    };

    return { store, saved };
}

function findHandler(tools: unknown[], name: string): ToolHandler {
    const found = (tools as { name: string; handler: unknown }[]).find(candidate => candidate.name === name);

    if (found === undefined) {
        throw new Error(`No tool ${name}`);
    }

    return found.handler as ToolHandler;
}

describe('limits_set', () => {
    it('changes only the fields the owner named and keeps the rest', async () => {
        const { store, saved } = createFakeStore({ ...NO_LIMITS, chat: { minutes: 10, usd: 1, steps: 20 } });
        const setLimits = findHandler(createLimitTools(store, 'bot-1'), 'limits_set');

        const result = await setLimits({ chatUsd: 3 }, {});

        expect(result.isError)
            .toBeUndefined();
        expect(saved)
            .toEqual([{ chat: { minutes: 10, usd: 3, steps: 20 }, routines: NO_LIMITS.routines }]);
    });

    it('removes a limit when given null', async () => {
        const { store, saved } = createFakeStore({ ...NO_LIMITS, routines: { minutes: 60, usd: null, steps: null } });
        const setLimits = findHandler(createLimitTools(store, 'bot-1'), 'limits_set');

        await setLimits({ routineMinutes: null }, {});

        expect(saved[0]?.routines.minutes)
            .toBeNull();
    });

    it('refuses an invalid value and saves nothing', async () => {
        const { store, saved } = createFakeStore(NO_LIMITS);
        const setLimits = findHandler(createLimitTools(store, 'bot-1'), 'limits_set');

        const result = await setLimits({ chatMinutes: 5000 }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toContain('chat.minutes must be');
        expect(saved)
            .toEqual([]);
    });
});
