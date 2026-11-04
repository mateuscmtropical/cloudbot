import type { ChatRole, MessageBody } from './chatTypes.ts';
import type { MascotColorName, MascotEyes, MascotShape } from './mascot.ts';

// A bot in a channel, shown with its current name and mascot.
interface ChannelMemberView {
    botId: string;
    name: string;
    mascotColor: MascotColorName;
    mascotShape: MascotShape;
    mascotEyes: MascotEyes;
    isManager: boolean;
}

interface ChannelSummary {
    id: string;
    name: string;
    // Members message only each other, and other bots cannot message them. It is not a security boundary.
    isIsolated: boolean;
    members: ChannelMemberView[];
}

// What the owner sets when making or changing a channel. The manager is one of the members.
interface ChannelSettings {
    name: string;
    memberIds: string[];
    managerId: string;
    isIsolated: boolean;
}

// One message in a channel. The author is copied when it is written, so it stays after the bot is deleted.
interface ChannelPostView {
    id: string;
    sequence: number;
    createdAt: number;
    authorName: string;
    authorColor: MascotColorName;
    authorShape: MascotShape;
    authorEyes: MascotEyes;
    role: ChatRole;
    body: MessageBody;
}

interface ChannelDetail extends ChannelSummary {
    messages: ChannelPostView[];
    // True while a bot works on the channel or waits to.
    hasActiveRound: boolean;
}

export type { ChannelDetail, ChannelMemberView, ChannelPostView, ChannelSettings, ChannelSummary };
