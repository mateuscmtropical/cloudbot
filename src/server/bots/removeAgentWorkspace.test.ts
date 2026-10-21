import { describe, expect, it } from 'vitest';

import { removeAgentWorkspace } from './removeAgentWorkspace.ts';
import type { RunCommand } from './removeAgentWorkspace.ts';

function recordingRun(calls: [string, string[]][]): RunCommand {
    return (file, args) => {
        calls.push([file, args]);

        return Promise.resolve();
    };
}

describe('removeAgentWorkspace', () => {
    it('runs the fixed helper as the agent user through sudo, with only the bot id', async () => {
        const calls: [string, string[]][] = [];

        await removeAgentWorkspace('bot', 'bot-abc_123', recordingRun(calls));

        expect(calls)
            .toEqual([['/usr/bin/sudo', ['-n', '-u', 'bot', '--', '/usr/local/bin/cloudbot-remove-workspace', 'bot-abc_123']]]);
    });

    it('refuses an id that is not a plain folder name, and runs nothing', async () => {
        const calls: [string, string[]][] = [];

        await expect(removeAgentWorkspace('bot', '../etc', recordingRun(calls)))
            .rejects.toThrow('Invalid bot id for a folder.');
        await expect(removeAgentWorkspace('bot', 'a/b', recordingRun(calls)))
            .rejects.toThrow('Invalid bot id for a folder.');
        await expect(removeAgentWorkspace('bot', '', recordingRun(calls)))
            .rejects.toThrow('Invalid bot id for a folder.');

        expect(calls)
            .toEqual([]);
    });

    it('lets a failed removal reach the caller', async () => {
        const failing: RunCommand = () => Promise.reject(new Error('The bot workspace could not be removed.'));

        await expect(removeAgentWorkspace('bot', 'bot-1', failing))
            .rejects.toThrow('The bot workspace could not be removed.');
    });
});
