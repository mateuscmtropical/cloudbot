import { useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactElement } from 'react';

interface DraftAttachment {
    id: string;
    name: string;
    status: 'uploading' | 'ready';
}

interface ComposerProps {
    botName: string;
    isRunning: boolean;
    attachments: DraftAttachment[];
    isUploading: boolean;
    onSend: (text: string) => void;
    onStop: () => void;
    onAttach: (files: File[]) => void;
    onRemoveAttachment: (attachmentId: string) => void;
}

function Composer({ botName, isRunning, attachments, isUploading, onSend, onStop, onAttach, onRemoveAttachment }: ComposerProps): ReactElement {
    const [draft, setDraft] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const trimmedDraft = draft.trim();
    // Send waits for uploads in flight, so their files reach this message and not the next one.
    const canSend = trimmedDraft.length > 0 && !isUploading;
    // A message sent during a turn is queued. Stop shows only while the draft is empty.
    const showStop = isRunning && trimmedDraft.length === 0;

    function sendDraft(): void {
        if (!canSend) {
            return;
        }

        onSend(trimmedDraft);
        setDraft('');
    }

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
        // Enter alone sends. Shift+Enter adds a line. Enter during IME composition belongs to the IME.
        const isSendKey = event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing;

        if (!isSendKey) {
            return;
        }

        event.preventDefault();
        sendDraft();
    }

    function handleFilesChosen(event: ChangeEvent<HTMLInputElement>): void {
        const selectedFiles = Array.from(event.target.files ?? []);

        onAttach(selectedFiles);
        event.target.value = '';
    }

    function openFilePicker(): void {
        fileInputRef.current?.click();
    }

    return (
        <>
            {attachments.length === 0
                ? null
                : (
                        <ul className="attachment-chips" aria-label="Attached files">
                            {attachments.map(attachment => (
                                <li key={attachment.id} className={`attachment-chip is-${attachment.status}`}>
                                    <span>{attachment.status === 'uploading' ? `${attachment.name} (uploading)` : attachment.name}</span>
                                    {attachment.status === 'ready'
                                        ? (
                                                <button
                                                    type="button"
                                                    className="attachment-remove"
                                                    aria-label={`Remove ${attachment.name}`}
                                                    onClick={() => {
                                                        onRemoveAttachment(attachment.id);
                                                    }}
                                                >
                                                    &times;
                                                </button>
                                            )
                                        : null}
                                </li>
                            ))}
                        </ul>
                    )}
            <div className="composer">
                <button type="button" className="icon-button" aria-label="Attach files" disabled={isRunning} onClick={openFilePicker}>+</button>
                <input ref={fileInputRef} type="file" multiple hidden onChange={handleFilesChosen} />
                <textarea
                    className="composer-input"
                    rows={1}
                    placeholder={`Message ${botName}`}
                    value={draft}
                    onChange={(event) => {
                        setDraft(event.target.value);
                    }}
                    onKeyDown={handleKeyDown}
                />
                {showStop
                    ? (
                            <button type="button" className="send-button is-stop" aria-label="Stop" onClick={onStop}>
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <rect x="7" y="7" width="10" height="10" rx="1" />
                                </svg>
                            </button>
                        )
                    : (
                            <button type="button" className="send-button" aria-label="Send" disabled={!canSend} onClick={sendDraft}>
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M4 12l16-8-6 16-2-6z" />
                                </svg>
                            </button>
                        )}
            </div>
        </>
    );
}

export { Composer };
export type { ComposerProps, DraftAttachment };
