import type { ReactElement } from 'react';

import type { ChatMessage } from '../../shared/chatTypes.ts';
import { renderMarkdown } from '../markdown.ts';
import { ChoiceButtons } from './ChoiceButtons.tsx';
import { CodeField } from './CodeField.tsx';
import { LinkCard } from './LinkCard.tsx';
import { SecureForm } from './SecureForm.tsx';

interface MessageActions {
    onChoose: (messageId: string, choiceId: string) => void;
    onSubmitCode: (messageId: string, code: string) => void;
    onSubmitSecret: (messageId: string, value: string) => void;
}

interface MessageItemProps {
    message: ChatMessage;
    actions: MessageActions;
}

function renderBody(message: ChatMessage, actions: MessageActions): ReactElement | null {
    const body = message.body;

    switch (body.kind) {
        case 'text':
            return <div className="bubble markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(body.text) }} />;
        case 'choice':
            return (
                <div className="setup-card">
                    <p>{body.prompt}</p>
                    <ChoiceButtons
                        options={body.options}
                        chosenId={body.chosenId}
                        onChoose={(choiceId) => {
                            actions.onChoose(message.id, choiceId);
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
                    onSubmit={(value) => {
                        actions.onSubmitSecret(message.id, value);
                    }}
                />
            );
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

function MessageItem({ message, actions }: MessageItemProps): ReactElement {
    const className = `message message-${message.role}`;

    return <div className={className}>{renderBody(message, actions)}</div>;
}

export { MessageItem };
export type { MessageActions, MessageItemProps };
