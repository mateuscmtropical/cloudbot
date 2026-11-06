import type { Channel } from '../store/ChannelStore.ts';
import type { Bot } from '../store/types.ts';

// A name the owner can put after @ at the start of a message: another bot, or a group whose manager takes the message.
interface AddressName {
    name: string;
    bot?: Bot;
    group?: Channel;
}

// Where an owner message that starts with @name goes, and its text without the @name.
interface OwnerAddress {
    name: string;
    text: string;
    bot?: Bot;
    group?: Channel;
}

function startsWithName(lowerText: string, name: string): boolean {
    const mention = `@${name.toLowerCase()}`;

    return lowerText === mention || lowerText.startsWith(`${mention} `) || lowerText.startsWith(`${mention}\n`);
}

// The @name at the start of an owner message in a bot's chat, or undefined when the message is for that bot.
// The longer name wins, so "@Ana Lee" goes to "Ana Lee" and not to "Ana". A bot wins over a group of the same name.
// A message that is only the @name has nothing to send, so it stays in the chat it was written in.
function findOwnerAddress(text: string, bots: Bot[], channels: Channel[], currentBotId: string): OwnerAddress | undefined {
    const trimmedText = text.trimStart();
    const lowerText = trimmedText.toLowerCase();
    const botNames: AddressName[] = bots
        .filter(bot => bot.id !== currentBotId)
        .map(bot => ({ name: bot.name, bot }));
    const groupNames: AddressName[] = channels.map(group => ({ name: group.name, group }));
    const matches = [...botNames, ...groupNames].filter(candidate => startsWithName(lowerText, candidate.name));
    const longest = matches.reduce<AddressName | undefined>((best, candidate) => (best === undefined || candidate.name.length > best.name.length ? candidate : best), undefined);

    if (longest === undefined) {
        return undefined;
    }

    const rest = trimmedText
        .slice(longest.name.length + 1)
        .trim();

    if (rest === '') {
        return undefined;
    }

    return { ...longest, text: rest };
}

export { findOwnerAddress };
export type { OwnerAddress };
