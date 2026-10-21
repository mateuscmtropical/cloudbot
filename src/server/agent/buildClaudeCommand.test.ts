import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildClaudeCommand, localClaudeConfigDir, validateAgentIsolation } from './buildClaudeCommand.ts';

describe('buildClaudeCommand in local mode', () => {
    it('gives the CLI its own config folder and drops the owner\'s Anthropic variables', () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'owner-key');
        vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'owner-token');
        try {
            const invocation = buildClaudeCommand('claude', ['auth', 'status'], '', '/data/claude-config');

            expect(invocation.command)
                .toBe('claude');
            expect(invocation.env?.CLAUDE_CONFIG_DIR)
                .toBe('/data/claude-config');
            expect(invocation.env)
                .not.toHaveProperty('ANTHROPIC_API_KEY');
            expect(invocation.env)
                .not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('keeps the plain command when no config folder is given', () => {
        expect(buildClaudeCommand('claude', ['auth', 'status'], ''))
            .toEqual({ command: 'claude', args: ['auth', 'status'] });
    });

    it('puts the local config folder under the data dir', () => {
        expect(localClaudeConfigDir('/data'))
            .toBe(join(resolve('/data'), 'claude-config'));
    });

    it('makes a relative data dir absolute, so every working directory gets the same folder', () => {
        const configDir = localClaudeConfigDir('./data');

        expect(isAbsolute(configDir))
            .toBe(true);
        expect(configDir)
            .toBe(join(resolve('./data'), 'claude-config'));
    });
});

describe('validateAgentIsolation', () => {
    it.each([undefined, ''])('refuses production startup without an agent user: %s', (user) => {
        expect(() => {
            validateAgentIsolation(user, 'production');
        })
            .toThrow('CLOUDBOT_AGENT_USER must be set in production');
    });

    it('allows local development and isolated production', () => {
        expect(() => {
            validateAgentIsolation(undefined, 'development');
        })
            .not.toThrow();
        expect(() => {
            validateAgentIsolation('bot', 'production');
        })
            .not.toThrow();
    });

    it('rejects invalid configured identities and relative isolated CLI paths', () => {
        expect(() => buildClaudeCommand('/opt/claude', [], '../root'))
            .toThrow('Invalid agent user');
        expect(() => buildClaudeCommand('claude', [], 'bot'))
            .toThrow('must be absolute');
    });
});
