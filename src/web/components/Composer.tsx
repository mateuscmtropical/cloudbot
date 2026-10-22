import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactElement } from 'react';

import { joinVoiceText, useVoiceInput } from '../voiceInput.ts';
import { PlusIcon } from './PlusIcon.tsx';

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
    // Reports whether the draft has text, so the bot's mascot can look at the message box.
    onTypingChange?: ((isTyping: boolean) => void) | undefined;
}

function Composer({ botName, isRunning, attachments, isUploading, onSend, onStop, onAttach, onRemoveAttachment, onTypingChange }: ComposerProps): ReactElement {
    const [draft, setDraft] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    // The text typed before the mic was pressed. Spoken words are added after it, and the owner edits all of it before sending.
    const draftBeforeVoiceRef = useRef('');
    const voice = useVoiceInput({
        language: navigator.language,
        onStart: () => {
            draftBeforeVoiceRef.current = draft;
        },
        onTranscript: (transcript) => {
            // An empty result changes nothing, so the draft keeps what the owner typed.
            if (transcript.trim() === '') {
                return;
            }

            const nextDraft = joinVoiceText(draftBeforeVoiceRef.current, transcript);

            setDraft(nextDraft);
            onTypingChange?.(nextDraft.trim().length > 0);
        },
    });
    const stopListening = voice.stopListening;

    // Another bot's chat must not receive the words of this one, so listening ends when the bot changes.
    useEffect(() => {
        return () => {
            stopListening();
        };
    }, [botName, stopListening]);

    const trimmedDraft = draft.trim();
    // Send waits for uploads in flight, so their files reach this message and not the next one.
    const canSend = trimmedDraft.length > 0 && !isUploading;
    // A message sent during a turn is queued. Stop shows only while the draft is empty.
    const showStop = isRunning && trimmedDraft.length === 0;

    function sendDraft(): void {
        if (!canSend) {
            return;
        }

        // Listening ends first, and the text before the mic is forgotten, so words still being heard cannot come back.
        stopListening();
        draftBeforeVoiceRef.current = '';
        onSend(trimmedDraft);
        setDraft('');
        onTypingChange?.(false);
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
                <button type="button" className="icon-button" aria-label="Attach files" disabled={isRunning} onClick={openFilePicker}>
                    <PlusIcon />
                </button>
                <input ref={fileInputRef} type="file" multiple hidden onChange={handleFilesChosen} />
                <textarea
                    className="composer-input"
                    rows={1}
                    placeholder={`Message ${botName}`}
                    value={draft}
                    onChange={(event) => {
                        // Typing takes over from the mic, so listening stops before the typed text is kept.
                        stopListening();
                        setDraft(event.target.value);
                        onTypingChange?.(event.target.value.trim().length > 0);
                    }}
                    onKeyDown={handleKeyDown}
                />
                {voice.isSupported
                    ? (
                            <button
                                type="button"
                                className={voice.isListening ? 'icon-button voice-button is-listening' : 'icon-button voice-button'}
                                aria-label="Voice input"
                                aria-pressed={voice.isListening}
                                onClick={voice.toggle}
                            >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <rect x="9" y="3" width="6" height="12" rx="3" />
                                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                                </svg>
                            </button>
                        )
                    : null}
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
            <p className="voice-status" role="status">{voice.statusText ?? ''}</p>
        </>
    );
}

export { Composer };
export type { ComposerProps, DraftAttachment };
