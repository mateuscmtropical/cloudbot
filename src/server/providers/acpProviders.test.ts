import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import type { ProviderMethod } from '../setup/SetupConversation.ts';
import { ACP_PROVIDERS, LOCAL_ACP_ARGS, PLACEHOLDER_KEY, methodRunner, offerAgyModels } from './acpProviders.ts';
import { ProviderModelCatalogs } from './ProviderModelCatalogs.ts';

describe('Grok ACP provider', () => {
    it('starts ACP with updates disabled and Ask permission mode forced', () => {
        expect(LOCAL_ACP_ARGS.grok)
            .toEqual(['--permission-mode', 'default', '--no-auto-update', 'agent', 'stdio']);
    });

    it('authenticates a subscription with the cached token in headless mode', () => {
        const grok = ACP_PROVIDERS.find(provider => provider.id === 'grok');

        expect(grok?.signIn)
            .toMatchObject({ site: 'xAI', authMethodId: 'cached_token', headlessAuth: true });
    });

    it('routes API key mode through Grok ACP and the local xAI proxy', () => {
        const grok = ACP_PROVIDERS.find(provider => provider.id === 'grok');
        const apiKey = grok?.apiKey;

        expect(apiKey)
            .toMatchObject({
                secretName: 'XAI_API_KEY',
                upstreamUrl: 'https://api.x.ai',
                keyHeader: { name: 'authorization', prefix: 'Bearer ' },
                checkUrl: 'https://api.x.ai/v1/models',
                authMethodId: 'xai.api_key',
                headlessAuth: true,
            });
        expect(apiKey?.environment('http://127.0.0.1:3456'))
            .toEqual({ XAI_API_KEY: PLACEHOLDER_KEY, GROK_XAI_API_BASE_URL: 'http://127.0.0.1:3456/v1' });
    });
});

describe('Gemini subscription models', () => {
    it('offers the agy model when the subscription reported none', () => {
        const catalogs = new ProviderModelCatalogs();

        offerAgyModels(catalogs, 'gemini', 'signIn');

        expect(catalogs.get('gemini')?.models)
            .toEqual([{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] }]);
    });

    it('leaves a Gemini key and a reported list alone', () => {
        const keyCatalogs = new ProviderModelCatalogs();
        const reportedCatalogs = new ProviderModelCatalogs();
        const reported = { models: [{ id: 'pro', label: 'Pro', efforts: [] }], defaultModel: 'pro', defaultEffort: null };

        reportedCatalogs.set('gemini', reported);
        offerAgyModels(keyCatalogs, 'gemini', 'apiKey');
        offerAgyModels(reportedCatalogs, 'gemini', undefined);

        expect(keyCatalogs.get('gemini'))
            .toBeUndefined();
        expect(reportedCatalogs.get('gemini'))
            .toEqual(reported);
    });
});

describe('methodRunner', () => {
    it('compacts on the runner of the way the owner connected last, and does nothing without one', async () => {
        const compacted: string[] = [];
        const recordingRunner = (name: string): AgentRunner => ({
            async* runTurn(): AsyncGenerator<AgentEvent> {
                await Promise.resolve();
                yield { type: 'text', text: name };
            },
            compactSession(): Promise<void> {
                compacted.push(name);

                return Promise.resolve();
            },
        });
        let method: ProviderMethod | undefined = 'apiKey';
        const runner = methodRunner(recordingRunner('sign-in'), recordingRunner('key'), () => Promise.resolve(method));

        await runner.compactSession?.(makeRequest());
        method = 'signIn';
        await runner.compactSession?.(makeRequest());
        const idle = methodRunner(undefined, undefined, () => Promise.resolve('signIn'));

        await idle.compactSession?.(makeRequest());

        expect(compacted)
            .toEqual(['key', 'sign-in']);
    });
});

function makeRequest(): TurnRequest {
    return { botId: 'bot-1', workspaceDir: '/tmp', prompt: 'Hello', abortSignal: new AbortController().signal };
}
