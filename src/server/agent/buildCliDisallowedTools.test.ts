import { describe, expect, it } from 'vitest';

import { buildCliDisallowedTools, CLI_DISALLOWED_TOOLS } from './buildCliDisallowedTools.ts';

describe('CLI_DISALLOWED_TOOLS', () => {
    it('blocks built-ins that use CLI features outside CloudBot', () => {
        expect(CLI_DISALLOWED_TOOLS)
            .toEqual([
                'CronCreate',
                'CronDelete',
                'CronList',
                'ScheduleWakeup',
                'RemoteTrigger',
                'PushNotification',
                'SendMessage',
                'ListAgents',
                'Workflow',
                'Monitor',
                'EnterWorktree',
                'ExitWorktree',
                'DesignSync',
                'ReportFindings',
                'TaskStop',
                'NotebookEdit',
                'PowerShell',
                'Skill',
            ]);
    });

    it('keeps owner blocks and removes duplicate disallowed names', () => {
        const ownerDisallowedTools = ['Bash(rm:*)', 'CronCreate'];

        expect(buildCliDisallowedTools(ownerDisallowedTools))
            .toEqual([...CLI_DISALLOWED_TOOLS, 'Bash(rm:*)']);
    });
});
