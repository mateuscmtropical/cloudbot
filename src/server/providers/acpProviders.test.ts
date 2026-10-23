import { describe, expect, it } from 'vitest';

import { ACP_PROVIDERS, LOCAL_ACP_ARGS, PLACEHOLDER_KEY } from './acpProviders.ts';

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
