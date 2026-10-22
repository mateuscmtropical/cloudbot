import { describe, expect, it } from 'vitest';
import { buildAgentEnvironment, validateAgentUser } from './createAgentUserSpawn.ts';

describe('buildAgentEnvironment', () => {
    it('passes only the proxy URL and a fixed dummy key in API key mode', () => {
        const environment = buildAgentEnvironment('bot', {
            HOME: '/var/lib/cloudbot',
            PATH: '/private/bin',
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
            ANTHROPIC_API_KEY: 'real-key',
            ANTHROPIC_AUTH_TOKEN: 'secret-token',
            SERVER_SECRET: 'private',
        });

        expect(environment)
            .toEqual({
                HOME: '/home/bot',
                PATH: '/usr/local/bin:/usr/bin:/bin',
                DISABLE_AUTOUPDATER: '1',
                ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
                ANTHROPIC_API_KEY: 'cloudbot-key-proxy',
            });
    });

    it('leaves credentials out when no key proxy is configured', () => {
        expect(buildAgentEnvironment('bot', { ANTHROPIC_API_KEY: 'secret' }))
            .toEqual({
                HOME: '/home/bot', PATH: '/usr/local/bin:/usr/bin:/bin', DISABLE_AUTOUPDATER: '1',
            });
    });

    it('adds the turn extra variables to the agent environment', () => {
        const environment = buildAgentEnvironment('bot', {}, { GH_HOST: '127.0.0.1:40123' });

        expect(environment.GH_HOST)
            .toBe('127.0.0.1:40123');
        expect(environment.HOME)
            .toBe('/home/bot');
    });
});

describe('validateAgentUser', () => {
    it('rejects names that are not a plain Linux user', () => {
        expect(() => {
            validateAgentUser('../root');
        })
            .toThrow('Invalid agent user');
        expect(() => {
            validateAgentUser('bot');
        })
            .not.toThrow();
    });
});
