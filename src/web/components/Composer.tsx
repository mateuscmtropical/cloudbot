import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactElement } from 'react';

import { stepBack, stepForward } from '../sentHistory.ts';
import { joinVoiceText, useVoiceInput } from '../voiceInput.ts';
import { PillField } from './PillField.tsx';
import { PopoverMenu, PopoverMenuItem } from './PopoverMenu.tsx';
import { CameraIcon, FolderIcon, ImageIcon, MicIcon, PlusIcon, SendArrowIcon, WaveformIcon } from './icons.tsx';

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
    // What the person sent in this chat, oldest first. The arrow keys bring it back into the message box.
    sentHistory?: string[] | undefined;
    // Reports whether the draft has text, so the bot's mascot can look at the message box.
    onTypingChange?: ((isTyping: boolean) => void) | undefined;
}

const NO_HISTORY: string[] = [];
// A phone or tablet keyboard. There Enter adds a line and only the send button sends.
const TOUCH_KEYBOARD_QUERY = '(pointer: coarse)';

function readIsTouchKeyboard(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia(TOUCH_KEYBOARD_QUERY).matches;
}

function Composer({ botName, isRunning, attachments, isUploading, onSend, onStop, onAttach, onRemoveAttachment, onTypingChange, sentHistory = NO_HISTORY }: ComposerProps): ReactElement {
    const [draft, setDraft] = useState('');
    const [isTouchKeyboard] = useState(readIsTouchKeyboard);
    // The message the arrow keys show, counted in sentHistory. Undefined while the person types their own text.
    const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
    // The text that was in the box before the arrow keys started, so arrow down can bring it back.
    const draftBeforeHistoryRef = useRef('');
    const activeHistoryIndex = historyIndex !== undefined && historyIndex < sentHistory.length ? historyIndex : undefined;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textAreaRef = useRef<HTMLTextAreaElement>(null);
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

    useLayoutEffect(() => {
        const textArea = textAreaRef.current;

        if (textArea === null) {
            return;
        }

        textArea.style.height = 'auto';
        const nextHeight = Math.min(textArea.scrollHeight, 120);

        textArea.style.height = `${nextHeight.toString()}px`;
    }, [draft]);

    function sendDraft(): void {
        if (!canSend) {
            return;
        }

        // Listening ends first, and the text before the mic is forgotten, so words still being heard cannot come back.
        stopListening();
        draftBeforeVoiceRef.current = '';
        onSend(trimmedDraft);
        setDraft('');
        setHistoryIndex(undefined);
        onTypingChange?.(false);
    }

    function stopTurn(): void {
        stopListening();
        draftBeforeVoiceRef.current = '';
        onStop();
    }

    function showDraft(nextDraft: string): void {
        stopListening();
        setDraft(nextDraft);
        onTypingChange?.(nextDraft.trim().length > 0);
    }

    // Arrow up brings back the sent messages, newest first. Arrow down goes forward, and past the newest it returns the text
    // that was in the box. The arrows only walk the history when the caret is on the first line (up) or the last line (down),
    // so a long message can still be edited with them. Returns true when the key was used.
    function walkHistory(goesBack: boolean, field: HTMLTextAreaElement): boolean {
        const textBeforeCaret = draft.slice(0, field.selectionStart);
        const textAfterCaret = draft.slice(field.selectionEnd);

        if (goesBack) {
            const olderIndex = stepBack(sentHistory.length, activeHistoryIndex);

            if (textBeforeCaret.includes('\n') || olderIndex === undefined) {
                return false;
            }

            if (activeHistoryIndex === undefined) {
                draftBeforeHistoryRef.current = draft;
            }

            setHistoryIndex(olderIndex);
            showDraft(sentHistory[olderIndex] ?? '');

            return true;
        }

        if (activeHistoryIndex === undefined || textAfterCaret.includes('\n')) {
            return false;
        }

        const newerIndex = stepForward(sentHistory.length, activeHistoryIndex);

        setHistoryIndex(newerIndex);
        showDraft(newerIndex === undefined ? draftBeforeHistoryRef.current : (sentHistory[newerIndex] ?? ''));

        return true;
    }

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
        const isArrow = event.key === 'ArrowUp' || event.key === 'ArrowDown';
        const hasModifier = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;

        if (isArrow && !hasModifier && !event.nativeEvent.isComposing) {
            const isUsed = walkHistory(event.key === 'ArrowUp', event.currentTarget);

            if (isUsed) {
                event.preventDefault();
            }

            return;
        }

        // Enter alone sends. Shift+Enter adds a line. Enter during IME composition belongs to the IME.
        // On a touch keyboard Enter always adds a line.
        const isSendKey = event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !isTouchKeyboard;

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

    function openFilePicker(accept?: string, capture?: string): void {
        const fileInput = fileInputRef.current;

        if (fileInput === null) {
            return;
        }

        if (accept === undefined) {
            fileInput.removeAttribute('accept');
        } else {
            fileInput.setAttribute('accept', accept);
        }

        if (capture === undefined) {
            fileInput.removeAttribute('capture');
        } else {
            fileInput.setAttribute('capture', capture);
        }

        fileInput.click();
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
                <PopoverMenu
                    label="Attachment options"
                    triggerLabel="Attach files"
                    triggerIcon={<PlusIcon />}
                    placement="above-start"
                    disabled={isRunning}
                >
                    {close => (
                        <>
                            <PopoverMenuItem label="Choose file" icon={<FolderIcon />} close={close} onSelect={() => { openFilePicker(); }} />
                            <PopoverMenuItem label="Take photo" icon={<CameraIcon />} close={close} onSelect={() => { openFilePicker('image/*', 'environment'); }} />
                            <PopoverMenuItem label="Photo or video" icon={<ImageIcon />} close={close} onSelect={() => { openFilePicker('image/*,video/*'); }} />
                        </>
                    )}
                </PopoverMenu>
                <input ref={fileInputRef} className="composer-file-input" type="file" multiple hidden onChange={handleFilesChosen} />
                <PillField className="composer-field">
                    <textarea
                        ref={textAreaRef}
                        className="composer-input"
                        rows={1}
                        enterKeyHint={isTouchKeyboard ? 'enter' : 'send'}
                        placeholder={`Ask ${botName}...`}
                        value={draft}
                        onChange={(event) => {
                            // Typing takes over from voice input, so listening stops before the typed text is kept.
                            stopListening();
                            setHistoryIndex(undefined);
                            setDraft(event.target.value);
                            onTypingChange?.(event.target.value.trim().length > 0);
                        }}
                        onKeyDown={handleKeyDown}
                    />
                    {trimmedDraft.length === 0 || !voice.isSupported
                        ? null
                        : (
                                <button
                                    type="button"
                                    className={voice.isListening ? 'composer-mic is-listening' : 'composer-mic'}
                                    aria-label="Voice input"
                                    aria-pressed={voice.isListening}
                                    onClick={voice.toggle}
                                >
                                    <MicIcon />
                                </button>
                            )}
                </PillField>
                {showStop
                    ? (
                            <button type="button" className="send-button" aria-label="Stop" onClick={stopTurn}>
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <rect x="7" y="7" width="10" height="10" rx="1" />
                                </svg>
                            </button>
                        )
                    : trimmedDraft.length === 0
                        ? (
                                <button
                                    type="button"
                                    className={voice.isListening ? 'send-button is-listening' : 'send-button'}
                                    aria-label="Voice input"
                                    aria-pressed={voice.isListening}
                                    disabled={!voice.isSupported}
                                    onClick={voice.toggle}
                                >
                                    <WaveformIcon />
                                </button>
                            )
                        : (
                                <button type="button" className="send-button" aria-label="Send" disabled={!canSend} onClick={sendDraft}>
                                    <SendArrowIcon />
                                </button>
                            )}
            </div>
            <p className="voice-status" role="status">{voice.statusText ?? ''}</p>
        </>
    );
}

export { Composer };
export type { ComposerProps, DraftAttachment };
