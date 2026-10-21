import { describe, expect, it, vi } from 'vitest';

import { getClaudeAuthStatus } from './getClaudeAuthStatus.ts';

describe('getClaudeAuthStatus', () => {
    it('uses sudo and only the bot environment when an agent user is configured', async () => {
        const runCommand = vi.fn()
            .mockResolvedValue('{"loggedIn":true}');

        vi.stubEnv('CLOUDBOT_AGENT_USER', 'bot');
        vi.stubEnv('SERVER_SECRET', 'private');
        try {
            await getClaudeAuthStatus({ claudePath: '/home/bot/.local/bin/claude', runCommand });
            expect(runCommand)
                .toHaveBeenCalledExactlyOnceWith('/usr/bin/sudo', [
                    '-n', '-u', 'bot', '--', '/home/bot/.local/bin/claude', 'auth', 'status', '--json',
                ], { HOME: '/home/bot', PATH: '/usr/local/bin:/usr/bin:/bin' });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('checks the status with CloudBot\'s own config folder in local mode', async () => {
        const runCommand = vi.fn()
            .mockResolvedValue('{"loggedIn":false}');

        await getClaudeAuthStatus({ claudePath: 'claude', configDir: '/data/claude-config', runCommand });

        expect(runCommand.mock.calls[0]?.[2])
            .toMatchObject({ CLAUDE_CONFIG_DIR: '/data/claude-config' });
    });

    it('maps the real CLI status shape and excludes account details', async () => {
        const runCommand = vi.fn()
            .mockResolvedValue(JSON.stringify({
                loggedIn: true,
                authMethod: 'claude.ai',
                apiProvider: 'firstParty',
                analyticsDisabled: false,
                projectsDirectory: '[REDACTED]',
                configDirectory: '[REDACTED]',
                email: '[REDACTED]',
                orgId: '[REDACTED]',
                orgName: '[REDACTED]',
                subscriptionType: 'max',
            }));

        expect(await getClaudeAuthStatus({ claudePath: '/opt/claude', runCommand }))
            .toEqual({ isLoggedIn: true, method: 'claude.ai' });
        expect(runCommand)
            .toHaveBeenCalledWith('/opt/claude', ['auth', 'status', '--json']);
    });

    it('returns signed-out status without requiring a method', async () => {
        const runCommand = vi.fn()
            .mockResolvedValue('{"loggedIn":false}');

        expect(await getClaudeAuthStatus({ claudePath: 'claude', runCommand }))
            .toEqual({ isLoggedIn: false });
    });

    it.each(['not JSON', 'null', '[]', '{}', '{"loggedIn":"true"}'])('rejects invalid status without exposing output: %s', async (output) => {
        const runCommand = vi.fn()
            .mockResolvedValue(output);

        await expect(getClaudeAuthStatus({ claudePath: 'claude', runCommand }))
            .rejects.toThrow(/invalid sign-in status/);
    });

    it('reports command failures without exposing CLI output', async () => {
        const runCommand = vi.fn()
            .mockRejectedValue(new Error('private CLI output'));

        await expect(getClaudeAuthStatus({ claudePath: 'claude', runCommand }))
            .rejects.toThrow('Could not check Claude sign-in status. Verify that the Claude CLI is installed and try again.');
    });
});
