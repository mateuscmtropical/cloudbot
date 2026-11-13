import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactElement } from 'react';

import { stepBack, stepForward } from '../sentHistory.ts';
import { joinVoiceText, useVoiceInput } from '../voiceInput.ts';
import { AttachmentTray } from './AttachmentTray.tsx';
import { PillField } from './PillField.tsx';
import { PopoverMenu, PopoverMenuItem } from './PopoverMenu.tsx';
import { CameraIcon, FolderIcon, ImageIcon, MicIcon, PlusIcon, SendArrowIcon, WaveformIcon } from './icons.tsx';

interface DraftAttachment {
    id: string;
    name: string;
    status: 'uploading' | 'ready';
    // The thumbnail of a ready image. Other files show an icon.
    previewUrl?: string | undefined;
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
    // False hides the button that attaches files.
    canAttach?: boolean;
    // The names a message can start with, as @name. Typing @ shows the ones that match.
    mentionNames?: string[] | undefined;
}

const NO_HISTORY: string[] = [];
const NO_NAMES: string[] = [];
const MAX_MENTIONS_SHOWN = 6;

// The names that match what follows an @ at the start of the draft. Nothing once the draft goes past a name.
function findMentionMatches(draft: string, names: string[]): string[] {
    if (!draft.startsWith('@')) {
        return [];
    }

    const typed = draft
        .slice(1)
        .toLowerCase();

    return names
        .filter(name => name.toLowerCase()
            .startsWith(typed))
        .slice(0, MAX_MENTIONS_SHOWN);
}
// A phone or tablet keyboard. There Enter adds a line and only the send button sends.
const TOUCH_KEYBOARD_QUERY = '(pointer: coarse)';

function readIsTouchKeyboard(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia(TOUCH_KEYBOARD_QUERY).matches;
}

function Composer({ botName, isRunning, attachments, isUploading, onSend, onStop, onAttach, onRemoveAttachment, onTypingChange, sentHistory = NO_HISTORY, canAttach = true, mentionNames = NO_NAMES }: ComposerProps): ReactElement {
    const [draft, setDraft] = useState('');
    const [isTouchKeyboard] = useState(readIsTouchKeyboard);
    // The message the arrow keys show, counted in sentHistory. Undefined while the person types their own text.
    const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
    // The text that was in the box before the arrow keys started, so arrow down can bring it back.
    const draftBeforeHistoryRef = useRef('');
    const caretAfterWalkRef = useRef<'start' | 'end' | undefined>(undefined);
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

    // A file dropped anywhere on the page goes to this chat, like the attach button. The page always takes the drop, so the
    // browser never opens the file in place of the app. While attaching is off, the drop does nothing.
    const canDrop = canAttach && !isRunning;
    // True while files are dragged over the page, so the drop target shows. It says whether the drop will be accepted.
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    // Moving between elements fires leave and enter, so the drag counts how many it has entered. A ref keeps the count when
    // the page renders again and the listeners below are set up anew.
    const enteredCountRef = useRef(0);

    useEffect(() => {
        const hasFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') === true;
        const takeEnter = (event: DragEvent): void => {
            if (hasFiles(event)) {
                enteredCountRef.current += 1;
                setIsDraggingFiles(true);
            }
        };
        const takeLeave = (event: DragEvent): void => {
            if (hasFiles(event)) {
                enteredCountRef.current = Math.max(0, enteredCountRef.current - 1);
                setIsDraggingFiles(enteredCountRef.current > 0);
            }
        };
        // The browser sends no pointer move during a drag, so a move or a blur means the drag is over, even when no leave came.
        const endDrag = (): void => {
            if (enteredCountRef.current === 0) {
                return;
            }

            enteredCountRef.current = 0;
            setIsDraggingFiles(false);
        };
        const takeDrag = (event: DragEvent): void => {
            if (event.dataTransfer?.types.includes('Files') === true) {
                event.preventDefault();
                event.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
            }
        };
        const takeDrop = (event: DragEvent): void => {
            endDrag();

            const droppedFiles = Array.from(event.dataTransfer?.files ?? []);

            if (droppedFiles.length === 0) {
                return;
            }

            event.preventDefault();

            if (canDrop) {
                onAttach(droppedFiles);
            }
        };

        window.addEventListener('dragenter', takeEnter);
        window.addEventListener('dragleave', takeLeave);
        window.addEventListener('dragover', takeDrag);
        window.addEventListener('drop', takeDrop);
        window.addEventListener('pointermove', endDrag);
        window.addEventListener('blur', endDrag);

        return () => {
            window.removeEventListener('dragenter', takeEnter);
            window.removeEventListener('dragleave', takeLeave);
            window.removeEventListener('dragover', takeDrag);
            window.removeEventListener('drop', takeDrop);
            window.removeEventListener('pointermove', endDrag);
            window.removeEventListener('blur', endDrag);
        };
    }, [canDrop, onAttach]);

    const dropRefusal = isRunning ? 'Wait for the reply to finish' : 'Attaching files is off here';

    const trimmedDraft = draft.trim();
    // Send waits for uploads in flight, so their files reach this message and not the next one.
    const canSend = trimmedDraft.length > 0 && !isUploading;
    // A message sent during a turn is queued. Stop shows only while the draft is empty.
    const showStop = isRunning && trimmedDraft.length === 0;
    const mentionMatches = findMentionMatches(draft, mentionNames);

    useLayoutEffect(() => {
        const textArea = textAreaRef.current;

        if (textArea === null) {
            return;
        }

        textArea.style.height = 'auto';
        const nextHeight = Math.min(textArea.scrollHeight, 120);

        textArea.style.height = `${nextHeight.toString()}px`;
    }, [draft]);

    // Puts the caret where the last walk through the history asked, once the message is in the box.
    useLayoutEffect(() => {
        const textArea = textAreaRef.current;
        const caretAfterWalk = caretAfterWalkRef.current;

        if (textArea === null || caretAfterWalk === undefined) {
            return;
        }

        caretAfterWalkRef.current = undefined;

        const caret = caretAfterWalk === 'start' ? 0 : textArea.value.length;

        textArea.setSelectionRange(caret, caret);
        textArea.scrollTop = caretAfterWalk === 'start' ? 0 : textArea.scrollHeight;
    });

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

    function chooseMention(name: string): void {
        caretAfterWalkRef.current = 'end';
        showDraft(`@${name} `);
        textAreaRef.current?.focus();
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
    // that was in the box. The caret lands where the next press in the same direction walks on.
    function walkHistory(goesBack: boolean): void {
        if (goesBack) {
            const olderIndex = stepBack(sentHistory.length, activeHistoryIndex);

            if (olderIndex === undefined) {
                return;
            }

            if (activeHistoryIndex === undefined) {
                draftBeforeHistoryRef.current = draft;
            }

            caretAfterWalkRef.current = 'start';
            setHistoryIndex(olderIndex);
            showDraft(sentHistory[olderIndex] ?? '');

            return;
        }

        if (activeHistoryIndex === undefined) {
            return;
        }

        const newerIndex = stepForward(sentHistory.length, activeHistoryIndex);

        caretAfterWalkRef.current = 'end';
        setHistoryIndex(newerIndex);
        showDraft(newerIndex === undefined ? draftBeforeHistoryRef.current : (sentHistory[newerIndex] ?? ''));
    }

    // The browser moves the caret between lines, wrapped ones too, and only it knows where a line wraps. So this looks after
    // the browser has acted. A caret that stayed put is on the first line (up) or the last line (down): it goes to the edge
    // of the text first, and a press from the edge walks the history. Some systems jump to the edge by themselves. While
    // walking, a caret that crossed a whole message from edge to edge was on a one line message, so that press walks too.
    function handleArrowKey(goesBack: boolean, field: HTMLTextAreaElement): void {
        const caret = field.selectionStart;

        if (caret !== field.selectionEnd) {
            return;
        }

        setTimeout(() => {
            const edge = goesBack ? 0 : field.value.length;
            const oppositeEdge = goesBack ? field.value.length : 0;
            const isWalking = activeHistoryIndex !== undefined;
            const hasStayed = field.selectionStart === caret && field.selectionEnd === caret;
            const hasCrossedMessage = field.selectionStart === edge && caret === oppositeEdge;

            if (!hasStayed && !(isWalking && hasCrossedMessage)) {
                return;
            }

            if (caret === edge || (isWalking && caret === oppositeEdge)) {
                walkHistory(goesBack);

                return;
            }

            field.setSelectionRange(edge, edge);
        }, 0);
    }

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
        const isArrow = event.key === 'ArrowUp' || event.key === 'ArrowDown';
        const hasModifier = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;

        if (isArrow && !hasModifier && !event.nativeEvent.isComposing) {
            handleArrowKey(event.key === 'ArrowUp', event.currentTarget);

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
            {isDraggingFiles
                ? (
                        <div className={canDrop ? 'drop-target' : 'drop-target is-refused'} role="status">
                            <p className="drop-target-text">{canDrop ? 'Drop to attach' : dropRefusal}</p>
                        </div>
                    )
                : null}
            <AttachmentTray attachments={attachments} onRemove={onRemoveAttachment} />
            {mentionMatches.length === 0
                ? null
                : (
                        <div className="composer-mentions" aria-label="Send to">
                            {mentionMatches.map(name => (
                                <button
                                    key={name}
                                    type="button"
                                    className="composer-mention"
                                    // The message box keeps the focus, so a phone keeps its keyboard open.
                                    onPointerDown={(event) => {
                                        event.preventDefault();
                                    }}
                                    onClick={() => {
                                        chooseMention(name);
                                    }}
                                >
                                    {`@${name}`}
                                </button>
                            ))}
                        </div>
                    )}
            <div className="composer">
                {canAttach
                    ? (
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
                        )
                    : null}
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
                    {trimmedDraft.length === 0
                        ? null
                        : (
                                <button
                                    type="button"
                                    className={voice.isListening ? 'composer-mic is-listening' : 'composer-mic'}
                                    aria-label="Voice input"
                                    aria-pressed={voice.isListening}
                                    disabled={voice.isTranscribing}
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
                                    disabled={voice.isTranscribing}
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
