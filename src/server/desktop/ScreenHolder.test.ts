import { describe, expect, it } from 'vitest';

import { ScreenHolder } from './ScreenHolder.ts';

describe('ScreenHolder', () => {
    it('starts with the bot holding the screen', () => {
        const screen = new ScreenHolder();

        expect(screen.holder)
            .toBe('bot');
        expect(screen.isPersonHolding)
            .toBe(false);
    });

    it('moves the screen to the person and back', () => {
        const screen = new ScreenHolder();

        screen.giveToPerson();

        expect(screen.holder)
            .toBe('person');
        expect(screen.isPersonHolding)
            .toBe(true);

        screen.giveToBot();

        expect(screen.holder)
            .toBe('bot');
    });
});
