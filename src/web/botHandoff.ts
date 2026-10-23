import type { BotSummary, ChatMessage } from '../shared/chatTypes.ts';
import { parseBotHandoffText } from '../shared/botHandoffText.ts';

// The bot that sent a hand-off, found by the name in the message. Undefined for any other message, or when the bot is gone.
function findHandoffSender(bots: BotSummary[], message: ChatMessage): BotSummary | undefined {
    if (message.role !== 'user' || message.body.kind !== 'text') {
        return undefined;
    }

    const handoff = parseBotHandoffText(message.body.text);

    return bots.find(bot => bot.name === handoff?.senderName);
}

export { findHandoffSender };
