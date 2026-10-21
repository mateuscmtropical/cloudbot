import { describe, expect, it } from 'vitest';

import { classifyToolCall } from './classifyToolCall.ts';

function classify(toolName: string): string {
    return classifyToolCall({ toolName, input: {} });
}

describe('classifyToolCall', () => {
    it.each([
        'Read',
        'Glob',
        'Grep',
        'mcp__cloudbot__browser_read',
        'mcp__cloudbot__browser_screenshot',
        'mcp__cloudbot__browser_scroll',
        'mcp__cloudbot__share_file',
    ])('skips the review for %s', (toolName) => {
        expect(classify(toolName))
            .toBe('skip');
    });

    it.each([
        'mcp__mail__send_email',
        'mcp__shop__purchase_item',
        'mcp__travel__bookFlight',
        'mcp__chat__reply-to-thread',
        'mcp__pay__checkout',
        'mcp__food__order_pizza',
    ])('always asks for the connector tool %s', (toolName) => {
        expect(classify(toolName))
            .toBe('always-ask');
    });

    it.each([
        'Bash',
        'Write',
        'WebFetch',
        'mcp__cloudbot__browser_click',
        'mcp__cloudbot__browser_type',
        'mcp__cloudbot__browser_key',
        'mcp__mail__list_messages',
        'mcp__docs__reorder_pages',
        'mcp__notes__sender_names',
    ])('sends %s to the reviewer', (toolName) => {
        expect(classify(toolName))
            .toBe('review');
    });
});
