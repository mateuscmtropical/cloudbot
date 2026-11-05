import { createElement, memo, useLayoutEffect, useRef } from 'react';
import type { ReactElement } from 'react';

import type { ChannelDetail, ChannelPostView } from '../../shared/channelTypes.ts';
import type { ChatMessage } from '../../shared/chatTypes.ts';
import { CloudMascot } from './CloudMascot.tsx';
import { Composer } from './Composer.tsx';
import { MascotStack } from './MascotStack.tsx';
import { MessageItem } from './MessageItem.tsx';
import type { MessageActions } from './MessageItem.tsx';
import { RoundButton } from './RoundButton.tsx';
import { ThinkingBubble } from './ThinkingBubble.tsx';
import { BackIcon, MoreIcon } from './icons.tsx';

const ROSTER_MASCOT_SIZE = 22;
const PILL_MASCOT_SIZE = 24;
const NEAR_BOTTOM_PX = 40;
const NO_ATTACHMENTS: [] = [];

// A channel post is text or a file, so nothing in it calls these.
const NO_ACTIONS: MessageActions = {
    onChoose: () => Promise.resolve(),
    onSubmitCode: () => undefined,
    onSubmitSecret: () => Promise.resolve(),
    onOpenScreen: () => undefined,
};

function doNothing(): void {
    // The composer of a group has no files yet.
}

interface ChannelViewProps {
    // Undefined while the channel loads.
    channel: ChannelDetail | undefined;
    onPost: (text: string) => void;
    onStop: () => void;
    onOpenBotList: () => void;
    onEdit: () => void;
}

interface ChannelPostProps {
    channelId: string;
    post: ChannelPostView;
}

// The bot's mascot and name sit beside its post. The owner's post and the notes of the app have none.
function ChannelPostItem({ channelId, post }: ChannelPostProps): ReactElement {
    const message: ChatMessage = { id: post.id, botId: '', role: post.role, createdAt: post.createdAt, sequence: post.sequence, body: post.body };
    const author = post.role === 'assistant' ? { name: post.authorName, color: post.authorColor, shape: post.authorShape, eyes: post.authorEyes } : undefined;
    const fileUrl = `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(post.id)}/file`;

    return <MessageItem message={message} actions={NO_ACTIONS} author={author} fileUrl={fileUrl} />;
}

// A stored post never changes, so a reload of the channel renders only the new ones.
const memoizedChannelPost = memo(ChannelPostItem, (previous, next) => previous.post.id === next.post.id && previous.channelId === next.channelId);

// A group chat with the owner and its bots. The app remounts it for each group, so each starts at its newest post.
function ChannelView({ channel, onPost, onStop, onOpenBotList, onEdit }: ChannelViewProps): ReactElement {
    const messageListRef = useRef<HTMLDivElement | null>(null);
    const isNearBottomRef = useRef(true);
    const postCount = channel?.messages.length ?? 0;
    const manager = channel?.members.find(member => member.isManager);

    useLayoutEffect(() => {
        const messageList = messageListRef.current;

        if (messageList !== null && isNearBottomRef.current) {
            messageList.scrollTop = messageList.scrollHeight;
        }
    }, [postCount, channel?.hasActiveRound]);

    return (
        <section className="conversation channel-view">
            <header className="conversation-header">
                <RoundButton label="Show bots" onClick={onOpenBotList}><BackIcon /></RoundButton>
                <button type="button" className="bot-pill" aria-label="Edit group" onClick={onEdit}>
                    <MascotStack members={channel?.members ?? []} size={PILL_MASCOT_SIZE} />
                    <span className="bot-pill-name">{channel?.name ?? ''}</span>
                </button>
                <RoundButton label="Group settings" onClick={onEdit}><MoreIcon /></RoundButton>
            </header>
            <div className="channel-roster-pill">
                {channel?.members.map(member => (
                    <span key={member.botId} className="channel-roster-member">
                        <CloudMascot color={member.mascotColor} shape={member.mascotShape} eyes={member.mascotEyes} state="idle" size={ROSTER_MASCOT_SIZE} />
                        <span className="channel-roster-name">{member.isManager ? `${member.name} (manager)` : member.name}</span>
                    </span>
                ))}
            </div>
            <div
                className="message-list"
                ref={messageListRef}
                onScroll={(event) => {
                    const list = event.currentTarget;

                    isNearBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= NEAR_BOTTOM_PX;
                }}
            >
                {channel?.messages.map(post => (
                    <div key={post.id} data-message-id={post.id}>
                        {createElement(memoizedChannelPost, { channelId: channel.id, post })}
                    </div>
                ))}
                {channel?.hasActiveRound === true && manager !== undefined
                    ? <ThinkingBubble mascotColor={manager.mascotColor} mascotShape={manager.mascotShape} />
                    : null}
            </div>
            <Composer
                botName={channel?.name ?? ''}
                isRunning={channel?.hasActiveRound === true}
                attachments={NO_ATTACHMENTS}
                isUploading={false}
                canAttach={false}
                onSend={(text) => {
                    isNearBottomRef.current = true;
                    onPost(text);
                }}
                onStop={onStop}
                onAttach={doNothing}
                onRemoveAttachment={doNothing}
            />
        </section>
    );
}

export { ChannelView };
export type { ChannelViewProps };
