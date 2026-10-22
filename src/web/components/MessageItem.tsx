import { memo } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary, ChatMessage } from '../../shared/chatTypes.ts';
import { TASK_LABELS, TASK_STATUSES } from '../../shared/taskTypes.ts';
import { formatFileSize } from '../formatFileSize.ts';
import { MESSAGE_MASCOT_SIZE } from '../messageMascot.ts';
import { renderMarkdown } from '../markdown.ts';
import type { MascotState } from '../mascotState.ts';
import { ChoiceButtons } from './ChoiceButtons.tsx';
import { CloudMascot } from './CloudMascot.tsx';
import { CodeField } from './CodeField.tsx';
import { LinkCard } from './LinkCard.tsx';
import { SecureForm } from './SecureForm.tsx';

// Raster images only. An img tag never runs scripts, so a file with another content under these types just fails to show.
const PREVIEW_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Larger images keep only the download link, so opening the chat does not fetch big files.
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

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
    // The bot whose mascot is shown beside an assistant message. Other messages show none.
    mascot?: Pick<BotSummary, 'mascotColor' | 'mascotShape'> | undefined;
    // Only the last bot message of a run draws the mascot. The others keep the space, so the text lines up.
    isMascotShown?: boolean | undefined;
    // The face of the mascot when it is shown. The typing face while the owner types.
    mascotState?: MascotState | undefined;
}

function renderBody(message: ChatMessage, actions: MessageActions): ReactElement | null {
    const body = message.body;

    switch (body.kind) {
        case 'text':
            return (
                <div className="text-message">
                    <div className="bubble markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(body.text) }} />
                    {body.attachments === undefined || body.attachments.length === 0
                        ? null
                        : (
                                <ul className="attachment-list">
                                    {body.attachments.map((file, index) => (
                                        <li key={`${String(index)}-${file.name}`} className="attachment-item">
                                            {file.name}
                                        </li>
                                    ))}
                                </ul>
                            )}
                    {body.isQueued === true ? <span className="queued-label">Queued</span> : null}
                </div>
            );
        case 'choice':
            return (
                <div className="setup-card">
                    {/* The approval card carries a script, so its line breaks and long lines are kept. */}
                    <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{body.prompt}</p>
                    <ChoiceButtons
                        options={body.options}
                        chosenId={body.chosenId}
                        onChoose={(choiceId) => {
                            void actions.onChoose(message.id, choiceId);
                        }}
                    />
                </div>
            );
        case 'link':
            return (
                <div className="setup-card">
                    <p>{body.text}</p>
                    <LinkCard label={body.label} url={body.url} />
                </div>
            );
        case 'tasks':
            return (
                <div className="setup-card task-board">
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
                </div>
            );
        case 'screenLink':
            return (
                <div className="setup-card">
                    <p>{body.text}</p>
                    <button
                        type="button"
                        className="choice-button"
                        onClick={() => {
                            actions.onOpenScreen();
                        }}
                    >
                        Open the screen
                    </button>
                </div>
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
                <div className="setup-card">
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
                </div>
            );
        case 'file': {
            const fileUrl = `/api/bots/${encodeURIComponent(message.botId)}/messages/${encodeURIComponent(message.id)}/file`;

            return (
                <div className="setup-card file-card">
                    {PREVIEW_IMAGE_TYPES.has(body.mimeType) && body.sizeBytes <= MAX_PREVIEW_BYTES
                        ? <img className="file-preview" src={fileUrl} alt={body.name} loading="lazy" />
                        : null}
                    <a className="link-card" href={fileUrl} download={body.name}>
                        {`Download ${body.name}`}
                    </a>
                    <span className="file-size">{formatFileSize(body.sizeBytes)}</span>
                </div>
            );
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

function MessageItemView({ message, actions, mascot, isMascotShown = false, mascotState = 'idle' }: MessageItemProps): ReactElement {
    const className = `message message-${message.role}`;

    if (mascot === undefined) {
        return <div className={className}>{renderBody(message, actions)}</div>;
    }

    return (
        <div className={`${className} has-mascot`}>
            {isMascotShown
                ? <CloudMascot color={mascot.mascotColor} shape={mascot.mascotShape} state={mascotState} size={MESSAGE_MASCOT_SIZE} />
                : <span className="mascot-gap" style={{ width: MESSAGE_MASCOT_SIZE }} aria-hidden="true" />}
            {renderBody(message, actions)}
        </div>
    );
}

// A streamed reply renders the list on every delta. Memo keeps the stored messages from parsing their markdown again.
const memoizedMessageItem = memo(MessageItemView);

export { memoizedMessageItem as MessageItem };
export type { MessageActions, MessageItemProps };
