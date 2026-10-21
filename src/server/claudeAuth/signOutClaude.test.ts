import { describe, expect, it, vi } from 'vitest';

import { signOutClaude } from './signOutClaude.ts';
import type { RunClaudeCommand } from './getClaudeAuthStatus.ts';

const SIGNED_OUT_STATUS = '{"loggedIn":false,"authMethod":"none"}';
const STILL_SIGNED_IN_STATUS = '{"loggedIn":true,"authMethod":"claude.ai"}';

// The fake CLI answers logout with no output, and status with the given JSON.
function fakeCli(statusOutput: string): ReturnType<typeof vi.fn<RunClaudeCommand>> {
    return vi.fn<RunClaudeCommand>()
        .mockImplementation((_command, args) => Promise.resolve(args.includes('status') ? statusOutput : ''));
}

describe('signOutClaude', () => {
    it('runs the CLI logout with only CloudBot\'s config folder in local mode', async () => {
        const runCommand = fakeCli(SIGNED_OUT_STATUS);

        await signOutClaude({ claudePath: 'claude', configDir: '/data/claude-config', platform: 'linux', runCommand });

        expect(runCommand.mock.calls[0]?.[0])
            .toBe('claude');
        expect(runCommand.mock.calls[0]?.[1])
            .toEqual(['auth', 'logout']);
        expect(runCommand.mock.calls[0]?.[2])
            .toMatchObject({ CLAUDE_CONFIG_DIR: '/data/claude-config' });
    });

    it('checks the sign-in status after logout with the same config folder', async () => {
        const runCommand = fakeCli(SIGNED_OUT_STATUS);

        await signOutClaude({ claudePath: 'claude', configDir: '/data/claude-config', platform: 'linux', runCommand });

        expect(runCommand.mock.calls[1]?.[1])
            .toEqual(['auth', 'status', '--json']);
        expect(runCommand.mock.calls[1]?.[2])
            .toMatchObject({ CLAUDE_CONFIG_DIR: '/data/claude-config' });
    });

    it('fails when the CLI still reports a sign-in after logout, even though logout did not throw', async () => {
        const runCommand = fakeCli(STILL_SIGNED_IN_STATUS);

        await expect(signOutClaude({ claudePath: 'claude', configDir: '/data/claude-config', platform: 'linux', runCommand }))
            .rejects
            .toThrow('Could not sign out of Claude. Try again.');
    });

    it('fails with a fixed message and no CLI output when the status cannot be read after logout', async () => {
        const runCommand = fakeCli('not json with token abc123');

        await expect(signOutClaude({ claudePath: 'claude', configDir: '/data/claude-config', platform: 'linux', runCommand }))
            .rejects
            .toThrow('Could not sign out of Claude. Try again.');
    });

    it('fails with a fixed message and no CLI output when logout fails', async () => {
        const runCommand = vi.fn<RunClaudeCommand>()
            .mockRejectedValue(new Error('token abc123 leaked'));

        await expect(signOutClaude({ claudePath: 'claude', configDir: '/data/claude-config', platform: 'linux', runCommand }))
            .rejects
            .toThrow('Could not sign out of Claude. Try again.');
    });

    it('refuses to run in local mode without a config folder, so the owner\'s login is never touched', async () => {
        const runCommand = fakeCli(SIGNED_OUT_STATUS);

        await expect(signOutClaude({ claudePath: 'claude', platform: 'linux', runCommand }))
            .rejects
            .toThrow('Sign out needs CloudBot\'s own Claude config folder.');
        expect(runCommand)
            .not.toHaveBeenCalled();
    });

    it('refuses local sign out on macOS, where the login is in the Keychain', async () => {
        const runCommand = fakeCli(SIGNED_OUT_STATUS);

        await expect(signOutClaude({ claudePath: 'claude', configDir: '/data/claude-config', platform: 'darwin', runCommand }))
            .rejects
            .toThrow('Sign out is not supported in local mode on macOS.');
        expect(runCommand)
            .not.toHaveBeenCalled();
    });

    it('still signs out of the agent user on macOS, since that path has its own login', async () => {
        const runCommand = fakeCli(SIGNED_OUT_STATUS);

        await signOutClaude({ claudePath: '/opt/claude', agentUser: 'bot', platform: 'darwin', runCommand });

        expect(runCommand.mock.calls[0]?.[0])
            .toBe('/usr/bin/sudo');
    });
});
