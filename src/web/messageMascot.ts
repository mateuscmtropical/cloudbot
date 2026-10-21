import type { ChatMessage } from '../shared/chatTypes.ts';

// The size of the mascot beside a message. The space of a mascot that is not shown uses the same size.
const MESSAGE_MASCOT_SIZE = 28;

interface DraftState {
    // A streamed reply is on screen. It is drawn after the last message.
    isShown: boolean;
    // The bot that the streamed reply belongs to.
    botId: string | undefined;
}

// A run is bot messages in a row. Only the last message of a run shows the bot's mascot.
function isLastOfBotRun(messages: ChatMessage[], index: number): boolean {
    const message = messages[index];

    if (message === undefined || message.role !== 'assistant') {
        return false;
    }

    const nextMessage = messages[index + 1];

    return nextMessage === undefined || nextMessage.role !== 'assistant' || nextMessage.botId !== message.botId;
}

// The streamed reply continues the run of the last message when both are bot messages of the same bot.
// Then the reply carries the mascot, and the last message does not.
function draftContinuesRun(messages: ChatMessage[], index: number, draft: DraftState): boolean {
    const message = messages[index];

    return draft.isShown
        && index === messages.length - 1
        && message !== undefined
        && message.role === 'assistant'
        && message.botId === draft.botId;
}

// Whether the message at this index shows the mascot: it ends its run, and no streamed reply carries the run on.
function showsMessageMascot(messages: ChatMessage[], index: number, draft: DraftState): boolean {
    return isLastOfBotRun(messages, index) && !draftContinuesRun(messages, index, draft);
}

export { MESSAGE_MASCOT_SIZE, isLastOfBotRun, showsMessageMascot };
export type { DraftState };
