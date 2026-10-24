import { describe, expect, it } from 'vitest';

import { announceAppReturn, APP_SIGN_IN_CHANNEL, describeAppReturn, readAppReturn, readAppReturnMessage } from './appReturn.ts';

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

describe('readAppReturnMessage', () => {
    it('reads the message the returning window sends', () => {
        expect(readAppReturnMessage({ apps: 'connected', app: 'notion', bot: 'bot-1' }))
            .toEqual({ appName: 'notion', outcome: 'connected' });
        expect(readAppReturnMessage({ apps: 'failed', app: null, bot: null }))
            .toEqual({ appName: undefined, outcome: 'failed' });
    });

    it('ignores anything else', () => {
        expect(readAppReturnMessage(undefined))
            .toBeUndefined();
        expect(readAppReturnMessage('connected'))
            .toBeUndefined();
        expect(readAppReturnMessage({ apps: 'whatever' }))
            .toBeUndefined();
    });
});

describe('announceAppReturn', () => {
    it('posts the apps, app and bot of the address on the sign-in channel', async () => {
        const listener = new BroadcastChannel(APP_SIGN_IN_CHANNEL);
        const received = new Promise((resolve) => {
            listener.onmessage = (event: MessageEvent<unknown>) => {
                resolve(event.data);
            };
        });

        announceAppReturn('?apps=connected&app=notion&bot=bot-1');

        await expect(received)
            .resolves.toEqual({ apps: 'connected', app: 'notion', bot: 'bot-1' });
        listener.close();
    });
});
