import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { ChannelDetail } from '../../shared/channelTypes.ts';
import { CloudMascot } from './CloudMascot.tsx';

const ROSTER_MASCOT_SIZE = 22;
const POST_MASCOT_SIZE = 28;

interface ChannelViewProps {
    // Undefined while the channel loads.
    channel: ChannelDetail | undefined;
    onPost: (text: string) => void;
    onStop: () => void;
    onOpenBotList: () => void;
}

// A group chat with the owner and its bots. Each bot posts with its own mascot. The owner posts with no mascot.
function ChannelView({ channel, onPost, onStop, onOpenBotList }: ChannelViewProps): ReactElement {
    const [draft, setDraft] = useState('');
    const messageListRef = useRef<HTMLDivElement | null>(null);
    const postCount = channel?.messages.length ?? 0;

    useLayoutEffect(() => {
        const messageList = messageListRef.current;

        if (messageList !== null) {
            messageList.scrollTop = messageList.scrollHeight;
        }
    }, [postCount]);

    function submit(): void {
        const text = draft.trim();

        if (text === '') {
            return;
        }

        onPost(text);
        setDraft('');
    }

    return (
        <section className="conversation channel-view">
            <header className="conversation-header">
                <button type="button" className="icon-button menu-button" aria-label="Show bots" onClick={onOpenBotList}>
                    &#9776;
                </button>
                <div className="bot-pill">
                    <span className="bot-pill-name">{channel?.name ?? ''}</span>
                </div>
            </header>
            <div className="channel-roster-pill">
                {channel?.members.map(member => (
                    <span key={member.botId} className="channel-roster-member">
                        <CloudMascot color={member.mascotColor} shape={member.mascotShape} eyes={member.mascotEyes} state="idle" size={ROSTER_MASCOT_SIZE} />
                        <span className="channel-roster-name">{member.isManager ? `${member.name} (manager)` : member.name}</span>
                    </span>
                ))}
            </div>
            <div className="channel-messages" ref={messageListRef}>
                {channel?.messages.map(post => (
                    <article key={post.id} className="channel-post" data-message-id={post.id}>
                        {post.role === 'user'
                            ? null
                            : <CloudMascot color={post.authorColor} shape={post.authorShape} eyes={post.authorEyes} state="idle" size={POST_MASCOT_SIZE} />}
                        <div className="channel-post-body">
                            <span className="channel-post-author">{post.authorName}</span>
                            <p className="channel-post-text">{post.body.kind === 'text' ? post.body.text : ''}</p>
                        </div>
                    </article>
                ))}
            </div>
            <form
                className="channel-composer"
                onSubmit={(event) => {
                    event.preventDefault();
                    submit();
                }}
            >
                <textarea
                    className="channel-composer-input"
                    aria-label="Message the channel"
                    rows={1}
                    value={draft}
                    onChange={(event) => {
                        setDraft(event.target.value);
                    }}
                />
                {channel?.hasActiveRound === true
                    ? <button type="button" className="channel-composer-send" onClick={onStop}>Stop</button>
                    : null}
                <button type="submit" className="channel-composer-send" disabled={draft.trim() === ''}>Send</button>
            </form>
        </section>
    );
}

export { ChannelView };
export type { ChannelViewProps };
