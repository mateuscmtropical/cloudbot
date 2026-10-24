import { describe, expect, it } from 'vitest';

import { diffTyping, isScreenKeyName, keysymOfCharacter } from './softKeyboard.ts';

describe('diffTyping', () => {
    it('reports typed characters', () => {
        expect(diffTyping(' ', ' a'))
            .toEqual({ backspaces: 0, text: 'a' });
    });

    it('reports a backspace when the anchor is deleted', () => {
        expect(diffTyping(' ', ''))
            .toEqual({ backspaces: 1, text: '' });
    });

    it('rewrites a word that the keyboard replaced', () => {
        expect(diffTyping(' helo', ' hello'))
            .toEqual({ backspaces: 1, text: 'lo' });
        expect(diffTyping(' teh', ' the'))
            .toEqual({ backspaces: 2, text: 'he' });
    });

    it('reports nothing when the field did not change', () => {
        expect(diffTyping(' ab', ' ab'))
            .toEqual({ backspaces: 0, text: '' });
    });
});

describe('keysymOfCharacter', () => {
    it('uses the character code for Latin-1, a base plus the code for the rest, and Enter for a new line', () => {
        expect(keysymOfCharacter('a'))
            .toBe(0x61);
        expect(keysymOfCharacter('ç'))
            .toBe(0xE7);
        expect(keysymOfCharacter('€'))
            .toBe(0x01000000 + 0x20AC);
        expect(keysymOfCharacter('\n'))
            .toBe(0xFF0D);
    });
});

describe('isScreenKeyName', () => {
    it('accepts the keys the screen knows and nothing else', () => {
        expect(isScreenKeyName('Backspace'))
            .toBe(true);
        expect(isScreenKeyName('F5'))
            .toBe(false);
    });
});
