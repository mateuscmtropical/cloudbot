import type { ChatMessage } from '../shared/chatTypes.ts';

function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
    const hasMessage = messages.some(existingMessage => existingMessage.id === message.id);

    if (!hasMessage) {
        return [...messages, message];
    }

    return messages.map(existingMessage => (existingMessage.id === message.id ? message : existingMessage));
}

export { upsertMessage };
