import { memo } from 'react';
import type { ReactElement } from 'react';

import type { AttachmentSummary, BotSummary, ChatMessage } from '../../shared/chatTypes.ts';
import type { MascotColorName, MascotEyes, MascotShape } from '../../shared/mascot.ts';
import { TASK_LABELS, TASK_STATUSES } from '../../shared/taskTypes.ts';
import { PREVIEW_IMAGE_TYPES } from '../../shared/previewImageTypes.ts';
import { readHandoff } from '../botHandoff.ts';
import type { HandoffView } from '../botHandoff.ts';
import { getRoutineSystemText } from '../messageList.ts';
import { renderMarkdown } from '../markdown.ts';
import { AttachmentGrid } from './AttachmentGrid.tsx';
import { Button } from './Button.tsx';
import { ChoiceButtons } from './ChoiceButtons.tsx';
import { CloudMascot } from './CloudMascot.tsx';
import { ChatCard } from './ChatCard.tsx';
import { CodeField } from './CodeField.tsx';
import { FileCard } from './FileCard.tsx';
import { LinkCard } from './LinkCard.tsx';
import { ReadAloudButton } from './ReadAloudButton.tsx';
import { SecureForm } from './SecureForm.tsx';
import { SharedFile } from './SharedFile.tsx';

const HANDOFF_MASCOT_SIZE = 28;

interface MessageActions {
    // Settles when the server answered.
    onChoose: (messageId: string, choiceId: string) => Promise<void>;
    onSubmitCode: (messageId: string, code: string) => void;
    onSubmitSecret: (messageId: string, value: string) => Promise<void>;
    // Opens the Screen panel again, for the link on a screen request.
    onOpenScreen: () => void;
}

interface MessageItemProps {
    message: ChatMessage;
    actions: MessageActions;
    // Used to show a message between two bots as a message of that bot. A stable list keeps the memo below working.
    bots?: BotSummary[] | undefined;
    // Shows the mascot and name of the bot that wrote it beside the message, as in a group.
    author?: MessageAuthor | undefined;
    // Where the file of this message is, when it is not in the chat of a bot.
    fileUrl?: string | undefined;
}

interface MessageAuthor {
    name: string;
    color: MascotColorName;
    shape: MascotShape;
    eyes: MascotEyes;
}

// Sent images show as a grid, and every other file, or an image from before copies were kept, as a card.
function renderAttachments(message: ChatMessage, attachments: AttachmentSummary[]): ReactElement {
    const sentImages = attachments.flatMap((file) => {
        if (file.fileId === undefined || !PREVIEW_IMAGE_TYPES.has(file.mimeType)) {
            return [];
        }

        const url = `/api/bots/${encodeURIComponent(message.botId)}/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(file.fileId)}`;

        return [{ url, name: file.name, width: file.width, height: file.height }];
    });
    const otherFiles = attachments.filter(file => file.fileId === undefined || !PREVIEW_IMAGE_TYPES.has(file.mimeType));

    return (
        <div className="message-attachments">
            {sentImages.length === 0 ? null : <AttachmentGrid images={sentImages} />}
            {otherFiles.map((file, index) => <FileCard key={`${String(index)}-${file.name}`} name={file.name} sizeBytes={file.sizeBytes} />)}
        </div>
    );
}

function renderBody(message: ChatMessage, actions: MessageActions, ownFileUrl: string | undefined): ReactElement | null {
    const body = message.body;

    switch (body.kind) {
        case 'text':
            return (
                <div className="text-message">
                    {body.author === undefined ? null : <span className="message-author">{body.author}</span>}
                    {body.attachments === undefined || body.attachments.length === 0 ? null : renderAttachments(message, body.attachments)}
                    <div className="bubble markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(body.text) }} />
                    {body.isQueued === true ? <span className="queued-label">Queued</span> : null}
                    {message.role === 'assistant' ? <ReadAloudButton messageId={message.id} text={body.text} /> : null}
                </div>
            );
        case 'choice':
            return (
                <ChatCard text={body.prompt}>
                    <ChoiceButtons
                        options={body.options}
                        chosenId={body.chosenId}
                        onChoose={(choiceId) => {
                            void actions.onChoose(message.id, choiceId);
                        }}
                    />
                </ChatCard>
            );
        case 'link':
            return (
                <ChatCard text={body.text}>
                    <LinkCard label={body.label} url={body.url} />
                </ChatCard>
            );
        case 'tasks':
            return (
                <ChatCard className="task-board">
                    {TASK_STATUSES.map((status) => {
                        const columnTasks = body.tasks.filter(task => task.status === status);

                        return (
                            <section key={status} className="task-column">
                                <h3>{TASK_LABELS[status]}</h3>
                                {columnTasks.map(task => (
                                    <div key={task.id} className="task-card">
                                        <p>{task.title}</p>
                                        {task.blockedReason === null ? null : <p className="task-reason">{task.blockedReason}</p>}
                                    </div>
                                ))}
                            </section>
                        );
                    })}
                    {body.hiddenCount > 0 ? <p className="task-more">{'and ' + String(body.hiddenCount) + ' more'}</p> : null}
                </ChatCard>
            );
        case 'screenLink':
            return (
                <ChatCard text={body.text}>
                    <Button
                        onClick={() => {
                            actions.onOpenScreen();
                        }}
                    >
                        Open the screen
                    </Button>
                </ChatCard>
            );
        case 'codeField':
            return (
                <CodeField
                    prompt={body.prompt}
                    placeholder={body.placeholder}
                    submitted={body.submitted}
                    onSubmit={(code) => {
                        actions.onSubmitCode(message.id, code);
                    }}
                />
            );
        case 'secureForm':
            return (
                <SecureForm
                    prompt={body.prompt}
                    secretName={body.secretName}
                    submitted={body.submitted}
                    site={body.site}
                    onSubmit={value => actions.onSubmitSecret(message.id, value)}
                    alternative={body.secretName === 'ANTHROPIC_API_KEY' && body.site === undefined
                        ? { label: 'Use subscription instead', onSelect: () => actions.onChoose(message.id, 'subscription') }
                        : undefined}
                />
            );
        case 'file': {
            const fileUrl = ownFileUrl ?? `/api/bots/${encodeURIComponent(message.botId)}/messages/${encodeURIComponent(message.id)}/file`;

            return <SharedFile file={body} url={fileUrl} />;
        }
        case 'toolActivity':
            return (
                <div className={`tool-line is-${body.status}`}>
                    <span className="tool-name">{body.toolName}</span>
                    <span className="tool-status">{body.status}</span>
                    <span className="tool-summary">{body.summary}</span>
                </div>
            );
        default:
            return null;
    }
}

// A message of a named bot sits on the bot side, with the mascot beside it and the name above the message.
function renderAuthored(author: MessageAuthor, content: ReactElement | null): ReactElement {
    return (
        <div className="message message-handoff has-mascot">
            <CloudMascot color={author.color} shape={author.shape} eyes={author.eyes} state="idle" size={HANDOFF_MASCOT_SIZE} />
            <div className="message-authored">
                <div className="handoff-sender">{author.name}</div>
                {content}
            </div>
        </div>
    );
}

// A message between two bots. A bot that is gone shows the default mascot.
function renderHandoff(handoff: HandoffView): ReactElement {
    const author: MessageAuthor = {
        name: handoff.label,
        color: handoff.bot?.mascotColor ?? 'blue',
        shape: handoff.bot?.mascotShape ?? 'puff',
        eyes: handoff.bot?.mascotEyes ?? 'smile',
    };

    return renderAuthored(author, <div className="text-message"><div className="bubble markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(handoff.text) }} /></div>);
}

function MessageItemView({ message, actions, bots, author, fileUrl }: MessageItemProps): ReactElement {
    const className = `message message-${message.role}`;
    const routineSystemText = getRoutineSystemText(message);
    const handoff = readHandoff(bots ?? [], message);

    if (author !== undefined) {
        const authoredBody = renderBody(message, actions, fileUrl);

        return renderAuthored(author, authoredBody);
    }

    if (handoff !== undefined) {
        return renderHandoff(handoff);
    }

    if (routineSystemText !== undefined) {
        return <div className="message message-system">{routineSystemText}</div>;
    }

    return <div className={className}>{renderBody(message, actions, fileUrl)}</div>;
}

// Stored messages render only when they change. The bot list only matters to a row that may be a message between bots, and a bot's own reply never is.
const memoizedMessageItem = memo(MessageItemView, (previous, next) => previous.message === next.message
    && previous.actions === next.actions
    && (previous.bots === next.bots || previous.message.role === 'assistant'));

export { memoizedMessageItem as MessageItem };
export type { MessageActions, MessageItemProps };
