import { describe, expect, it } from 'vitest';

import { listBlockedToolNames, toSdkToolName } from './applyRules.ts';
import type { BotRule } from './RuleStore.ts';

function buildRule(kind: BotRule['kind'], blockedTools: string[]): BotRule {
    return { id: 'rule', botId: 'bot', kind, sentence: 'Sentence.', blockedTools, createdAt: 1 };
}

describe('toSdkToolName', () => {
    it('expands a cloudbot tool name to the full name', () => {
        expect(toSdkToolName('browser_open'))
            .toBe('mcp__cloudbot__browser_open');
    });

    it('keeps built in tools and full names as written', () => {
        expect(toSdkToolName('Bash'))
            .toBe('Bash');
        expect(toSdkToolName('mcp__other__tool'))
            .toBe('mcp__other__tool');
    });
});

describe('listBlockedToolNames', () => {
    it('lists the tools of block rules once each', () => {
        const rules = [buildRule('block', ['Bash', 'browser_open']), buildRule('block', ['Bash'])];

        expect(listBlockedToolNames(rules))
            .toEqual(['Bash', 'mcp__cloudbot__browser_open']);
    });

    it('ignores the tools of an allow rule', () => {
        expect(listBlockedToolNames([buildRule('allow', ['Bash'])]))
            .toEqual([]);
    });
});
