import { describe, expect, it, vi } from 'vitest';

import { ConnectedProviders } from './ConnectedProviders.ts';
import type { ProviderId } from './providerIds.ts';

describe('ConnectedProviders', () => {
    it('asks the CLIs once for reads close together and again after a sign-in changed', async () => {
        let version = 1;
        const askProviders = vi.fn((): Promise<ProviderId[]> => Promise.resolve(['claude']));
        const connected = new ConnectedProviders(askProviders, () => version);

        await connected.read();
        await connected.read();

        expect(askProviders)
            .toHaveBeenCalledTimes(1);

        version = 2;
        askProviders.mockResolvedValue(['claude', 'gemini']);

        await expect(connected.read())
            .resolves
            .toEqual(['claude', 'gemini']);
        expect(askProviders)
            .toHaveBeenCalledTimes(2);
    });

    it('shares one running check and keeps its answer as the last one', async () => {
        const askProviders = vi.fn((): Promise<ProviderId[]> => Promise.resolve(['gemini']));
        const connected = new ConnectedProviders(askProviders);

        expect(connected.last())
            .toBeUndefined();

        await Promise.all([connected.check(), connected.read()]);

        expect(askProviders)
            .toHaveBeenCalledTimes(1);
        expect(connected.last())
            .toEqual(['gemini']);
    });
});
