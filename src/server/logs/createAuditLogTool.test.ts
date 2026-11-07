import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ActionLog } from './ActionLog.ts';
import { createAuditLogTool } from './createAuditLogTool.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>;

async function run(log: ActionLog, botId: string, args: Record<string, unknown>): Promise<string> {
    const tool = createAuditLogTool(log, botId) as unknown as { handler: ToolHandler };
    const result = await tool.handler(args, {});

    return result.content[0]?.text ?? '';
}

describe('createAuditLogTool', () => {
    it('lists only the calls of its own bot and filters by decision', async () => {
        const log = new ActionLog(join(mkdtempSync(join(tmpdir(), 'cloudbot-audit-tool-')), 'actions.log'));

        log.write({ botId: 'bot-1', event: 'review', tool: 'Bash', decision: 'blocked', decidedBy: 'block list', reason: 'Dangerous.' });
        log.write({ botId: 'bot-1', event: 'review', tool: 'Read', decision: 'allowed' });
        log.write({ botId: 'bot-2', event: 'review', tool: 'Bash', decision: 'blocked' });
        log.write({ botId: 'bot-1', event: 'tool_finished', tool: 'Bash' });

        const blocked = await run(log, 'bot-1', { decision: 'blocked' });
        const everything = await run(log, 'bot-1', {});

        expect(blocked)
            .toContain('blocked by block list: Bash (Dangerous.)');
        expect(blocked.split('\n'))
            .toHaveLength(1);
        expect(everything.split('\n'))
            .toHaveLength(2);
        expect(await run(log, 'bot-3', {}))
            .toBe('No matching entries.');
    });
});
