import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { BotRule } from './RuleStore.ts';

const MCP_PREFIX = 'mcp__';

// An owner writes `browser_open`. The SDK knows the tool as `mcp__cloudbot__browser_open`.
// Built in tools such as `Bash` start with a capital letter and `mcp__` names are already full, so both stay as written.
function toSdkToolName(ownerToolName: string): string {
    const isFullName = ownerToolName.startsWith(MCP_PREFIX) || /^[A-Z]/.test(ownerToolName);

    return isFullName ? ownerToolName : `${MCP_PREFIX}${PROFILE_SERVER_NAME}__${ownerToolName}`;
}

function listBlockedToolNames(rules: BotRule[]): string[] {
    const blockedNames = rules
        .filter(rule => rule.kind === 'block')
        .flatMap(rule => rule.blockedTools)
        .map(toSdkToolName);

    return [...new Set(blockedNames)];
}

export { listBlockedToolNames, toSdkToolName };
