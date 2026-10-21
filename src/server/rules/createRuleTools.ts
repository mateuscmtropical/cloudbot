import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

import type { CloudbotTool, ProfileToolResult } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { BotRuleRecord, RuleStore } from '../store/RuleStore.ts';
import { MAX_BLOCKED_TOOLS, MAX_RULE_TEXT_LENGTH, isRuleInputError, parseRuleInput } from './parseRuleInput.ts';

const RULE_LIST_TOOL_NAME = 'rule_list';
const RULE_CHANGE_TOOL_NAME = 'rule_change';
const RULE_LIST_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${RULE_LIST_TOOL_NAME}`;
const RULE_CHANGE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${RULE_CHANGE_TOOL_NAME}`;
const RULE_TOOL_FULL_NAMES = [RULE_LIST_TOOL_FULL_NAME, RULE_CHANGE_TOOL_FULL_NAME];

const LIST_DESCRIPTION = 'List your rules with their ids. Use it when the owner asks what you may or may not do.';
const CHANGE_DESCRIPTION = 'Propose a change to your rules. Rules are permissions, so the owner approves each change in the chat before it is made. Use action "add" with kind "allow" or "block", the rule text, and for a block rule the tool names it must not use (such as Bash or WebFetch). Use action "remove" with the rule id from rule_list.';

const LIST_SHAPE = {};

const ACTION_SCHEMA = z.enum(['add', 'remove']);
const KIND_SCHEMA = z.enum(['allow', 'block'])
    .optional();
const TEXT_SCHEMA = z.string()
    .max(MAX_RULE_TEXT_LENGTH)
    .optional();
const TOOL_NAME_SCHEMA = z.string();
const BLOCKED_TOOLS_SCHEMA = z.array(TOOL_NAME_SCHEMA)
    .max(MAX_BLOCKED_TOOLS)
    .optional();
const RULE_ID_SCHEMA = z.string()
    .optional();

const CHANGE_SHAPE = {
    action: ACTION_SCHEMA,
    kind: KIND_SCHEMA,
    text: TEXT_SCHEMA,
    blockedTools: BLOCKED_TOOLS_SCHEMA,
    ruleId: RULE_ID_SCHEMA,
};

function textResult(text: string, isError: boolean): ProfileToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function describeRule(rule: BotRuleRecord): string {
    const toolsText = rule.blockedTools.length === 0 ? '' : ` (blocked tools: ${rule.blockedTools.join(', ')})`;

    return `- id ${rule.id}, ${rule.kind}: ${rule.text}${toolsText}`;
}

// The rules of the bot, oldest first. Each line has the id that rule_change needs.
// rule_change is offered only with the approval gate, since a rule change always waits for the owner.
function createRuleTools(ruleStore: RuleStore, botId: string, canPropose: boolean): CloudbotTool[] {
    const listTool = tool(
        RULE_LIST_TOOL_NAME,
        LIST_DESCRIPTION,
        LIST_SHAPE,
        async (): Promise<ProfileToolResult> => {
            const rules = await ruleStore.list(botId);

            if (rules.length === 0) {
                return textResult('This bot has no rules yet.', false);
            }

            const ruleLines = rules.map(describeRule);
            const listText = ruleLines.join('\n');

            return textResult(listText, false);
        },
    );

    // The approval gate has already asked the owner when this runs. The input is checked again here, as the model sent it.
    const changeTool = tool(
        RULE_CHANGE_TOOL_NAME,
        CHANGE_DESCRIPTION,
        CHANGE_SHAPE,
        async (args): Promise<ProfileToolResult> => {
            if (args.action === 'remove') {
                const isRemoved = args.ruleId === undefined ? false : await ruleStore.remove(botId, args.ruleId);

                return isRemoved
                    ? textResult('Removed the rule.', false)
                    : textResult('No rule of this bot has that id.', true);
            }

            const parsed = parseRuleInput(args);

            if (isRuleInputError(parsed)) {
                return textResult(parsed.error, true);
            }

            await ruleStore.add(botId, parsed);

            return textResult(`Added the ${parsed.kind} rule.`, false);
        },
    );

    return canPropose ? [listTool, changeTool] : [listTool];
}

export { RULE_CHANGE_TOOL_FULL_NAME, RULE_LIST_TOOL_FULL_NAME, RULE_TOOL_FULL_NAMES, createRuleTools };
