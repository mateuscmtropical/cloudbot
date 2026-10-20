import { describe, expect, it } from 'vitest';
import { buildClaudeCommand, validateAgentIsolation } from './buildClaudeCommand.ts';

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
