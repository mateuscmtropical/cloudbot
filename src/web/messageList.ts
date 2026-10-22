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

// Adds a message from the event stream or a request. A message the list does not hold that is
// older than the bot's oldest held message is left out: it comes with an older page, and adding
// it now would move the paging cursor past the messages between.
function upsertLiveMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
    const isHeld = messages.some(existingMessage => existingMessage.id === message.id);
    const botSequences = messages
        .filter(existingMessage => existingMessage.botId === message.botId)
        .map(existingMessage => existingMessage.sequence);
    const isOlderThanHeld = botSequences.length > 0 && message.sequence < Math.min(...botSequences);

    if (!isHeld && isOlderThanHeld) {
        return messages;
    }

    const updatedMessages = upsertMessage(messages, message);

    return [...updatedMessages].sort((first, second) => first.sequence - second.sequence);
}

// Drops the messages of a quiet check-in. An id the list does not hold is ignored.
function removeMessages(messages: ChatMessage[], messageIds: string[]): ChatMessage[] {
    const removedIds = new Set(messageIds);

    return messages.filter(message => !removedIds.has(message.id));
}

// The page size the web app asks for. A page with fewer messages than this is the last one.
const MESSAGE_PAGE_SIZE = 50;

export { MESSAGE_PAGE_SIZE, mergeMessages, removeMessages, upsertLiveMessage, upsertMessage };
