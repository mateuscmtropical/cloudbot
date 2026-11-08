import { describe, expect, it, vi } from 'vitest';

import { getClaudeUsageText } from './getClaudeUsage.ts';

describe('getClaudeUsageText', () => {
    it('runs the local usage command with the bot config folder and returns its text', async () => {
        const runCommand = vi.fn()
            .mockResolvedValue(JSON.stringify({ type: 'result', result: 'Current session: 25% used' }));

        const text = await getClaudeUsageText({ claudePath: 'claude', configDir: '/data/claude-config', runCommand });

        expect(text)
            .toBe('Current session: 25% used');
        expect(runCommand.mock.calls[0]?.[1])
            .toEqual(['-p', '/usage', '--output-format', 'json', '--no-session-persistence']);
        expect(runCommand.mock.calls[0]?.[2])
            .toMatchObject({ CLAUDE_CONFIG_DIR: '/data/claude-config' });
    });

    it('returns no text when the answer has no result', async () => {
        const runCommand = vi.fn()
            .mockResolvedValue('{"type":"result"}');

        expect(await getClaudeUsageText({ claudePath: 'claude', runCommand }))
            .toBe('');
    });

    it('fails when the CLI is missing', async () => {
        await expect(getClaudeUsageText({ claudePath: '/missing/claude-for-test' })).rejects.toThrow('Could not read the Claude usage.');
    });
});
