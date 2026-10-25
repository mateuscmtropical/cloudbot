import { describe, expect, it, vi } from 'vitest';

import { skipAfterFailure } from './skipAfterFailure.ts';

describe('skipAfterFailure', () => {
    it('skips a failed review model for a while and tries it again later', async () => {
        const clock = { time: 0 };
        const askModel = vi.fn()
            .mockRejectedValueOnce(new Error('no sign-in'))
            .mockResolvedValue('{}');
        const ask = skipAfterFailure(askModel, 1000, () => clock.time);

        await expect(ask('prompt'))
            .rejects
            .toThrow('no sign-in');
        await expect(ask('prompt'))
            .rejects
            .toThrow('a moment ago');

        clock.time = 1000;

        await expect(ask('prompt'))
            .resolves
            .toBe('{}');
        expect(askModel)
            .toHaveBeenCalledTimes(2);
    });
});
