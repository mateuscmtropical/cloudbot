import { afterEach, expect, it, vi } from 'vitest';

import { checkApiKey } from './checkApiKey.ts';

afterEach(() => {
    vi.unstubAllGlobals();
});

it('checks the in-memory key directly with Anthropic and releases the response', async () => {
    const cancel = vi.fn<() => Promise<void>>()
        .mockResolvedValue(undefined);
    const fetchMock = vi.fn()
        .mockResolvedValue({ status: 401, body: { cancel } });

    vi.stubGlobal('fetch', fetchMock);
    expect(await checkApiKey('test-key'))
        .toBe(401);
    expect(fetchMock)
        .toHaveBeenCalledWith('https://api.anthropic.com/v1/models', {
            headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'test-key' },
            redirect: 'error',
            signal: expect.any(AbortSignal) as AbortSignal,
        });
    expect(cancel)
        .toHaveBeenCalledOnce();
});
