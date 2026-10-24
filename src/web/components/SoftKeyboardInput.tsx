import { useRef } from 'react';
import type { CompositionEvent, KeyboardEvent, ReactElement, RefObject, SyntheticEvent } from 'react';

import { FIELD_ANCHOR, diffTyping, isScreenKeyName } from '../softKeyboard.ts';
import type { ScreenKeyName } from '../softKeyboard.ts';

interface SoftKeyboardInputProps {
    inputRef: RefObject<HTMLTextAreaElement | null>;
    onText: (text: string) => void;
    onKey: (key: ScreenKeyName) => void;
}

// An invisible text field. The panel focuses it so the keyboard of a phone opens, and the changes go to the screen of the bot
// as keys. The keyboard may suggest and rewrite words, so each change is compared with what was already sent.
function SoftKeyboardInput({ inputRef, onText, onKey }: SoftKeyboardInputProps): ReactElement {
    const sentRef = useRef(FIELD_ANCHOR);
    const isComposingRef = useRef(false);

    function reset(field: HTMLTextAreaElement): void {
        field.value = FIELD_ANCHOR;
        sentRef.current = FIELD_ANCHOR;
    }

    function sendChange(field: HTMLTextAreaElement): void {
        const change = diffTyping(sentRef.current, field.value);

        sentRef.current = field.value;
        Array.from({ length: change.backspaces })
            .forEach(() => {
                onKey('Backspace');
            });

        if (change.text !== '') {
            onText(change.text);
        }
    }

    function handleInput(event: SyntheticEvent<HTMLTextAreaElement>): void {
        const field = event.currentTarget;

        sendChange(field);

        if (!isComposingRef.current) {
            reset(field);
        }
    }

    function handleCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>): void {
        const field = event.currentTarget;

        isComposingRef.current = false;
        sendChange(field);
        reset(field);
    }

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
        if (event.nativeEvent.isComposing || !isScreenKeyName(event.key)) {
            return;
        }

        event.preventDefault();
        onKey(event.key);
    }

    return (
        <textarea
            ref={inputRef}
            className="desktop-keyboard-input"
            aria-label="Type on the screen"
            defaultValue={FIELD_ANCHOR}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            rows={1}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
                isComposingRef.current = true;
            }}
            onCompositionEnd={handleCompositionEnd}
        />
    );
}

export { SoftKeyboardInput };
