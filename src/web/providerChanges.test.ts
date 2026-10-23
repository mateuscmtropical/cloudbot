import { describe, expect, it } from 'vitest';

import type { ChatMessage, MessageBody } from '../shared/chatTypes.ts';
import { countProviderChanges } from './providerChanges.ts';

function message(body: MessageBody, sequence: number): ChatMessage {
    return { id: `m${String(sequence)}`, botId: 'bot', role: 'assistant', createdAt: sequence, sequence, body };
}

describe('countProviderChanges', () => {
    it('counts answered provider cards and finished provider_use calls', () => {
        const messages = [
            message({ kind: 'choice', prompt: 'Switch?', options: [{ id: 'gemini', label: 'Gemini' }], isProviderSwitch: true, chosenId: 'gemini' }, 1),
            message({ kind: 'toolActivity', toolName: 'mcp__cloudbot__provider_use', status: 'done', summary: 'Switched' }, 2),
        ];

        expect(countProviderChanges(messages))
            .toBe(2);
    });

    it('counts a ready message that says the bot runs on a provider now', () => {
        const messages = [
            message({ kind: 'text', text: 'OpenCode is ready. What would you like to do?', providerSwitched: true }, 1),
        ];

        expect(countProviderChanges(messages))
            .toBe(1);
    });

    it('ignores open cards, running calls and other messages', () => {
        const messages = [
            message({ kind: 'choice', prompt: 'Switch?', options: [{ id: 'gemini', label: 'Gemini' }], isProviderSwitch: true }, 1),
            message({ kind: 'toolActivity', toolName: 'mcp__cloudbot__provider_use', status: 'running', summary: '' }, 2),
            message({ kind: 'toolActivity', toolName: 'mcp__cloudbot__provider_list', status: 'done', summary: '' }, 3),
            message({ kind: 'choice', prompt: 'Other?', options: [{ id: 'a', label: 'A' }], chosenId: 'a' }, 4),
            message({ kind: 'text', text: 'Hi' }, 5),
        ];

        expect(countProviderChanges(messages))
            .toBe(0);
    });
});
