import type { ToolCallVerdict } from '../approvals/ApprovalGate.ts';
import { hasHiddenCode } from '../text/isHiddenCode.ts';
import type { RuleStore } from '../store/RuleStore.ts';
import { isRuleInputError, parseRuleInput } from './parseRuleInput.ts';

const NOT_FOUND_REASON = 'This bot has no rule with that id, so there is nothing to remove.';
const HIDDEN_CODE_REASON = 'The rule text has hidden characters, so the card cannot show it whole.';

function readText(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function readField(input: unknown, field: string): unknown {
    return typeof input === 'object' && input !== null ? Reflect.get(input, field) : undefined;
}

// The approval card of a rule change. The card shows the rule text, so the owner reads what the bot wants to allow or block.
// A change that the server would refuse anyway is refused before the owner is asked.
async function describeRuleChange(ruleStore: RuleStore, botId: string, input: unknown): Promise<ToolCallVerdict> {
    const actionValue = readField(input, 'action');
    const action = readText(actionValue);

    if (action === 'remove') {
        const ruleIdValue = readField(input, 'ruleId');
        const ruleId = readText(ruleIdValue);
        const rules = await ruleStore.list(botId);
        const rule = rules.find(candidate => candidate.id === ruleId);

        if (rule === undefined) {
            return { decision: 'deny', reason: NOT_FOUND_REASON };
        }

        // The stored text is checked too, so the card never hides characters the owner cannot see.
        if (hasHiddenCode(rule.text)) {
            return { decision: 'deny', reason: HIDDEN_CODE_REASON };
        }

        return { decision: 'ask', summary: 'Remove a rule of this bot.', detail: `Rule to remove (${rule.kind}): ${JSON.stringify(rule.text)}` };
    }

    const parsed = parseRuleInput(input);

    if (isRuleInputError(parsed)) {
        return { decision: 'deny', reason: parsed.error };
    }

    if (hasHiddenCode(parsed.text) || parsed.blockedTools.some(toolName => hasHiddenCode(toolName))) {
        return { decision: 'deny', reason: HIDDEN_CODE_REASON };
    }

    const toolsLine = parsed.blockedTools.length === 0 ? '' : `\nBlocked tools: ${parsed.blockedTools.join(', ')}`;

    return {
        decision: 'ask',
        summary: 'Add a rule to this bot.',
        detail: `Rule (${parsed.kind}): ${JSON.stringify(parsed.text)}${toolsLine}`,
    };
}

export { describeRuleChange };
