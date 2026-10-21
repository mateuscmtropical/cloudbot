import { describe, expect, it } from 'vitest';

import { MAX_RULE_TEXT_LENGTH, parseRuleInput } from './parseRuleInput.ts';

describe('parseRuleInput', () => {
    it('accepts a block rule with tool names and collapses the text', () => {
        expect(parseRuleInput({ kind: 'block', text: '  Never   run\nrm. ', blockedTools: ['Bash(rm:*)', 'WebFetch', 'WebFetch'] }))
            .toEqual({ kind: 'block', text: 'Never run rm.', blockedTools: ['Bash(rm:*)', 'WebFetch'] });
    });

    it('accepts an allow rule without tools', () => {
        expect(parseRuleInput({ kind: 'allow', text: 'You may read my calendar.' }))
            .toEqual({ kind: 'allow', text: 'You may read my calendar.', blockedTools: [] });
    });

    it('refuses a bad kind, empty or long text and an allow rule that names tools', () => {
        expect(parseRuleInput({ kind: 'maybe', text: 'x' }))
            .toEqual({ error: 'Send kind as "allow" or "block".' });
        expect(parseRuleInput({ kind: 'block', text: '   ' }))
            .toHaveProperty('error');
        expect(parseRuleInput({ kind: 'block', text: 'a'.repeat(MAX_RULE_TEXT_LENGTH + 1) }))
            .toHaveProperty('error');
        expect(parseRuleInput({ kind: 'allow', text: 'x', blockedTools: ['Bash'] }))
            .toEqual({ error: 'Only a block rule can name tools.' });
    });

    it('refuses tool names that are not tool names', () => {
        expect(parseRuleInput({ kind: 'block', text: 'x', blockedTools: ['rm -rf /'] }))
            .toHaveProperty('error');
        expect(parseRuleInput({ kind: 'block', text: 'x', blockedTools: 'Bash' }))
            .toHaveProperty('error');
        expect(parseRuleInput({ kind: 'block', text: 'x', blockedTools: [42] }))
            .toHaveProperty('error');
        expect(parseRuleInput({ kind: 'block', text: 'x', blockedTools: ['Bash(git push, rm:*)'] }))
            .toHaveProperty('error');
    });
});
