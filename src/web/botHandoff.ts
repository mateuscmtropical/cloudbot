import type { BotSummary, ChatMessage } from '../shared/chatTypes.ts';
import { parseBotHandoffText, parseHandoffNote } from '../shared/botHandoffText.ts';

// A message between two bots, as the chat shows it.
interface HandoffView {
    label: string;
    text: string;
    // The bot whose mascot shows beside the message. Undefined when it is gone.
    bot: BotSummary | undefined;
}

function findByName(bots: BotSummary[], name: string): BotSummary | undefined {
    return bots.find(bot => bot.name === name);
}

// A hand-off a bot received is a user message. The note of one it sent, and the reply to it, are system messages.
function readHandoff(bots: BotSummary[], message: ChatMessage): HandoffView | undefined {
    if (message.body.kind !== 'text') {
        return undefined;
    }

    if (message.role === 'user') {
        const received = parseBotHandoffText(message.body.text);

        return received === undefined ? undefined : { label: received.senderName, text: received.text, bot: findByName(bots, received.senderName) };
    }

    if (message.role !== 'system') {
        return undefined;
    }

    const botNames = bots.map(bot => bot.name);
    const note = parseHandoffNote(message.body.text, botNames);

    if (note === undefined) {
        return undefined;
    }

    if (note.direction === 'sent') {
        return { label: `To ${note.botName}`, text: note.text, bot: bots.find(bot => bot.id === message.botId) };
    }

    return { label: note.outcome === undefined ? note.botName : `${note.botName} (${note.outcome})`, text: note.text, bot: findByName(bots, note.botName) };
}

export { readHandoff };
export type { HandoffView };
