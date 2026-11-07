import { z } from 'zod/v4';

import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { ActionLog } from './ActionLog.ts';

const AUDIT_LOG_TOOL_NAME = 'audit_log';
const AUDIT_LOG_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${AUDIT_LOG_TOOL_NAME}`;
const DESCRIPTION = 'Read the audit log of your own tool calls: what ran, what the owner approved or denied, what the review agent refused and what the block list stopped. Newest first. Use it when the owner asks what you did or what was blocked. Filter by decision and by hours back.';
const DECISIONS = ['allowed', 'owner_approved', 'owner_denied', 'blocked', 'refused', 'not_answered', 'review_failed'] as const;
const SHAPE = {
    decision: z.enum(DECISIONS)
        .optional(),
    hours: z.number()
        .optional(),
};
const DEFAULT_HOURS = 24;
const MAX_LINES = 50;
const HOUR_MS = 60 * 60 * 1000;

interface AuditLogToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
}

// Reads only the calls of this bot. The log holds names, outcomes and short lines, never inputs or secrets.
function createAuditLogTool(actionLog: Pick<ActionLog, 'read'>, botId: string): CloudbotTool {
    return tool(AUDIT_LOG_TOOL_NAME, DESCRIPTION, SHAPE, (args): Promise<AuditLogToolResult> => {
        const hours = args.hours === undefined || !(args.hours > 0) ? DEFAULT_HOURS : args.hours;
        const entries = actionLog.read(MAX_LINES, botId, args.decision, Date.now() - hours * HOUR_MS)
            .filter(entry => entry.event === 'review');
        const lines = entries.map((entry) => {
            const by = entry.decidedBy === undefined ? '' : ` by ${entry.decidedBy}`;
            const note = entry.summary ?? entry.reason;

            return `${entry.at} ${entry.decision ?? 'unknown'}${by}: ${entry.tool ?? 'unknown tool'}${note === undefined ? '' : ` (${note})`}`;
        });
        const text = lines.length === 0 ? 'No matching entries.' : lines.join('\n');

        return Promise.resolve({ content: [{ type: 'text' as const, text }] });
    });
}

export { AUDIT_LOG_TOOL_FULL_NAME, createAuditLogTool };
