// Helpers for typing on the screen of the bot with the keyboard of a phone.

type ScreenKeyName = 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'PageUp' | 'PageDown';

interface TypingChange {
    backspaces: number;
    text: string;
}

// The field always holds one space in front. A backspace on an empty field then still changes the field,
// so the keyboard reports it.
const FIELD_ANCHOR = ' ';
const SCREEN_KEY_NAMES: ScreenKeyName[] = ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'];
// X11 key symbols, as VNC sends them.
const KEYSYMS: Record<ScreenKeyName, number> = {
    Backspace: 0xFF08,
    Tab: 0xFF09,
    Enter: 0xFF0D,
    Escape: 0xFF1B,
    ArrowLeft: 0xFF51,
    ArrowUp: 0xFF52,
    ArrowRight: 0xFF53,
    ArrowDown: 0xFF54,
    PageUp: 0xFF55,
    PageDown: 0xFF56,
};
const LATIN1_LAST_CODE_POINT = 0xFF;
const UNICODE_KEYSYM_BASE = 0x01000000;

function isScreenKeyName(key: string): key is ScreenKeyName {
    return SCREEN_KEY_NAMES.some(name => name === key);
}

// What the owner changed in the field since the last time it was read. A keyboard that suggests words
// rewrites the word being typed, so this finds the common start and counts what was removed after it.
function diffTyping(previous: string, next: string): TypingChange {
    const previousChars = Array.from(previous);
    const nextChars = Array.from(next);
    const firstDifference = previousChars.findIndex((char, index) => nextChars[index] !== char);
    const sharedLength = firstDifference === -1 ? previousChars.length : firstDifference;

    return {
        backspaces: previousChars.length - sharedLength,
        text: nextChars.slice(sharedLength)
            .join(''),
    };
}

// VNC names a Latin-1 character by its code. Any other character is the code plus a base.
function keysymOfCharacter(character: string): number {
    if (character === '\n') {
        return KEYSYMS.Enter;
    }

    const codePoint = character.codePointAt(0) ?? 0;

    return codePoint <= LATIN1_LAST_CODE_POINT ? codePoint : UNICODE_KEYSYM_BASE + codePoint;
}

function hasTouchScreen(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

export { FIELD_ANCHOR, KEYSYMS, diffTyping, hasTouchScreen, isScreenKeyName, keysymOfCharacter };
export type { ScreenKeyName, TypingChange };
