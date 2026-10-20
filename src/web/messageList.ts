import type { ChatMessage } from '../shared/chatTypes.ts';

function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
    const hasMessage = messages.some(existingMessage => existingMessage.id === message.id);

    if (!hasMessage) {
        return [...messages, message];
    }

    return messages.map(existingMessage => (existingMessage.id === message.id ? message : existingMessage));
}

// Merges a loaded list into the current one without losing messages that arrived
// by the event stream, and keeps the conversation in store order.
function mergeMessages(currentMessages: ChatMessage[], loadedMessages: ChatMessage[]): ChatMessage[] {
    const mergedMessages = loadedMessages.reduce(upsertMessage, currentMessages);

    return [...mergedMessages].sort((first, second) => first.sequence - second.sequence);
}

export { mergeMessages, upsertMessage };
