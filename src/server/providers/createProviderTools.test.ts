import { describe, expect, it, vi } from 'vitest';

import { createProviderTools } from './createProviderTools.ts';
import type { ProviderToolDependencies } from './createProviderTools.ts';
import type { ProviderId } from './providerIds.ts';

interface CallableTool {
    name: string;
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

function makeTools(connected: ProviderId[], available: ProviderId[] = ['claude', 'chatgpt']): { tools: CallableTool[]; dependencies: ProviderToolDependencies } {
    const dependencies: ProviderToolDependencies = {
        available,
        connected: () => Promise.resolve(connected),
        providerFor: () => Promise.resolve('claude'),
        setProvider: vi.fn(() => Promise.resolve()),
        offerProviders: vi.fn(() => Promise.resolve()),
    };
    const tools = createProviderTools(dependencies, 'bot-1') as unknown as CallableTool[];

    return { tools, dependencies };
}

async function call(tools: CallableTool[], name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const found = tools.find(entry => entry.name === name);
    const result = await found!.handler(args, {});

    return { text: result.content[0]?.text ?? '', isError: result.isError === true };
}

describe('provider tools', () => {
    it('lists each provider with its state and the one this bot uses', async () => {
        const { tools } = makeTools(['claude']);

        const result = await call(tools, 'provider_list');

        expect(result.text)
            .toBe('Providers: Claude (claude, connected, used by this bot), ChatGPT (chatgpt, not connected).');
    });

    it('switches the bot to a connected provider', async () => {
        const { tools, dependencies } = makeTools(['claude', 'chatgpt']);

        const result = await call(tools, 'provider_use', { provider: 'chatgpt' });

        expect(result.isError)
            .toBe(false);
        expect(dependencies.setProvider)
            .toHaveBeenCalledWith('bot-1', 'chatgpt');
    });

    it('refuses a provider that is not connected or not installed', async () => {
        const signedOut = makeTools(['claude']);
        const missing = makeTools(['claude'], ['claude']);

        const notConnected = await call(signedOut.tools, 'provider_use', { provider: 'chatgpt' });
        const notInstalled = await call(missing.tools, 'provider_use', { provider: 'chatgpt' });

        expect(notConnected)
            .toMatchObject({ isError: true, text: 'ChatGPT is not connected. Call provider_connect so the owner can sign in first.' });
        expect(notInstalled)
            .toMatchObject({ isError: true, text: 'ChatGPT is not installed on this server.' });
        expect(signedOut.dependencies.setProvider)
            .not.toHaveBeenCalled();
    });

    it('posts the provider list in the setup chat', async () => {
        const { tools, dependencies } = makeTools(['claude']);

        await call(tools, 'provider_connect');

        expect(dependencies.offerProviders)
            .toHaveBeenCalledOnce();
    });
});
