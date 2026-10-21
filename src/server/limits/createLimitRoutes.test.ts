import { describe, expect, it } from 'vitest';

import type { TurnLimits } from '../../shared/limitTypes.ts';
import type { LimitStore } from '../store/LimitStore.ts';
import { createLimitRoutes } from './createLimitRoutes.ts';

const NO_LIMITS: TurnLimits = {
    chat: { minutes: null, usd: null, steps: null },
    routines: { minutes: null, usd: null, steps: null },
};
const LIMITS_PATH = '/api/bots/bot-1/limits';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// An in-memory store that remembers every save.
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

function createRoutes(initial: TurnLimits = NO_LIMITS): { routes: ReturnType<typeof createLimitRoutes>; saved: TurnLimits[] } {
    const { store, saved } = createFakeStore(initial);
    const routes = createLimitRoutes({ limitStore: store, hasBot: botId => Promise.resolve(botId === 'bot-1') });

    return { routes, saved };
}

describe('limit routes', () => {
    it('GET returns the limits with their bounds', async () => {
        const { routes } = createRoutes({ ...NO_LIMITS, chat: { minutes: 15, usd: null, steps: null } });

        const response = await routes.request(LIMITS_PATH);
        const body = await response.json() as TurnLimits & { bounds: Record<string, { min: number; max: number; isWhole: boolean }> };

        expect(response.status)
            .toBe(200);
        expect(body.chat.minutes)
            .toBe(15);
        expect(body.bounds.minutes)
            .toEqual({ min: 1, max: 1440, isWhole: true });
        expect(body.bounds.usd)
            .toEqual({ min: 0.01, max: 1000, isWhole: false });
    });

    it('PUT saves the nested limits and returns them', async () => {
        const { routes, saved } = createRoutes();
        const limits: TurnLimits = {
            chat: { minutes: 5, usd: 0.5, steps: null },
            routines: { minutes: null, usd: null, steps: 9 },
        };

        const response = await routes.request(LIMITS_PATH, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(limits) });

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual(limits);
        expect(saved)
            .toEqual([limits]);
    });

    it('PUT with an out-of-range value is a 400 and saves nothing', async () => {
        const { routes, saved } = createRoutes();

        const response = await routes.request(LIMITS_PATH, {
            method: 'PUT',
            headers: JSON_HEADERS,
            body: JSON.stringify({ chat: { minutes: 5000 } }),
        });
        const body = await response.json() as { error: string };

        expect(response.status)
            .toBe(400);
        expect(body.error)
            .toContain('chat.minutes must be');
        expect(saved)
            .toEqual([]);
    });

    it('answers 404 for an unknown bot', async () => {
        const { routes } = createRoutes();

        const getResponse = await routes.request('/api/bots/bot-9/limits');
        const putResponse = await routes.request('/api/bots/bot-9/limits', { method: 'PUT', headers: JSON_HEADERS, body: '{}' });

        expect(getResponse.status)
            .toBe(404);
        expect(putResponse.status)
            .toBe(404);
    });

    it('answers 400 for a body that is not JSON and saves nothing', async () => {
        const { routes, saved } = createRoutes();

        const response = await routes.request(LIMITS_PATH, { method: 'PUT', headers: JSON_HEADERS, body: '{not json' });

        expect(response.status)
            .toBe(400);
        expect(saved)
            .toEqual([]);
    });
});
