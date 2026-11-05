import { describe, expect, it, vi } from 'vitest';

import { MAX_ENTRIES, createActionLogRoutes } from './createActionLogRoutes.ts';

describe('createActionLogRoutes', () => {
    it('answers with the entries of the log, for one bot when asked', async () => {
        const entries = [{ at: '2026-11-05T10:00:00.000Z', botId: 'bot-1', event: 'turn_error' as const }];
        const read = vi.fn(() => entries);
        const routes = createActionLogRoutes({ actionLog: { read } });

        const response = await routes.request('/api/action-log?botId=bot-1');

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual(entries);
        expect(read)
            .toHaveBeenCalledWith(MAX_ENTRIES, 'bot-1');
    });
});
