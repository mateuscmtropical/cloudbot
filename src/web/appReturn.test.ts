import { describe, expect, it } from 'vitest';

import { describeAppReturn, readAppReturn } from './appReturn.ts';

describe('readAppReturn', () => {
    it('reads the app and the outcome from the address the sign-in page sends the owner back to', () => {
        expect(readAppReturn('?apps=connected&app=notion&bot=bot-1'))
            .toEqual({ appName: 'notion', outcome: 'connected' });
        expect(readAppReturn('?apps=failed'))
            .toEqual({ appName: undefined, outcome: 'failed' });
    });

    it('ignores any other address', () => {
        expect(readAppReturn(''))
            .toBeUndefined();
        expect(readAppReturn('?bot=bot-1&message=m1'))
            .toBeUndefined();
        expect(readAppReturn('?apps=whatever'))
            .toBeUndefined();
    });
});

describe('describeAppReturn', () => {
    it('says what happened in plain words', () => {
        expect(describeAppReturn({ appName: 'notion', outcome: 'connected' }))
            .toBe('Notion is connected.');
        expect(describeAppReturn({ appName: 'linear', outcome: 'failed' }))
            .toBe('Linear was not connected. Try again.');
        expect(describeAppReturn({ appName: undefined, outcome: 'failed' }))
            .toBe('The app was not connected. Try again.');
    });
});
