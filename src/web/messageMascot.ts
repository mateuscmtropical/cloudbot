import type { ChatMessage } from '../shared/chatTypes.ts';

// The size of the mascot beside a message. The space of a mascot that is not shown uses the same size.
const MESSAGE_MASCOT_SIZE = 28;

interface DraftState {
    // A streamed reply is on screen. It is drawn after the last message.
    isShown: boolean;
    // The bot that the streamed reply belongs to.
    botId: string | undefined;
}

// The mascot follows the conversation down, so only the latest message of each bot shows it.
// In a channel each bot keeps its own mascot on its latest message.
function isLatestOfBot(messages: ChatMessage[], index: number): boolean {
    const message = messages[index];

    if (message === undefined || message.role !== 'assistant') {
        return false;
    }

    const laterMessages = messages.slice(index + 1);

    return !laterMessages.some(laterMessage => laterMessage.role === 'assistant' && laterMessage.botId === message.botId);
}

// Whether the message at this index shows the mascot: it is the bot's latest message, and no streamed reply of the
// same bot is on screen, since the streamed reply then carries the mascot.
function showsMessageMascot(messages: ChatMessage[], index: number, draft: DraftState): boolean {
    const message = messages[index];
    const isDraftOfSameBot = draft.isShown && message !== undefined && message.botId === draft.botId;

    return isLatestOfBot(messages, index) && !isDraftOfSameBot;
}

export { MESSAGE_MASCOT_SIZE, isLatestOfBot, showsMessageMascot };
export type { DraftState };
