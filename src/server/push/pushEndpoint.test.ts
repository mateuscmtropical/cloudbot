import { describe, expect, it } from 'vitest';

import { parsePushEndpoint } from './pushEndpoint.ts';

describe('parsePushEndpoint', () => {
    it.each([
        'https://fcm.googleapis.com/fcm/send/abc',
        'https://updates.push.services.mozilla.com/wpush/v2/abc',
        'https://web.push.apple.com/abc',
        'https://wns2-par02p.notify.windows.com/w/?token=abc',
        'https://FCM.GOOGLEAPIS.COM/fcm/send/abc',
    ])('accepts the push service address %s', (endpoint) => {
        expect(parsePushEndpoint(endpoint))
            .toBeInstanceOf(URL);
    });

    it.each([
        ['an http address', 'http://fcm.googleapis.com/fcm/send/abc'],
        ['another host', 'https://example.com/fcm/send/abc'],
        ['a loopback address', 'https://127.0.0.1/fcm/send/abc'],
        ['the metadata address', 'https://169.254.169.254/latest/meta-data'],
        ['a look-alike host', 'https://fcm.googleapis.com.evil.test/fcm/send/abc'],
        ['a host that only ends with the name', 'https://evilfcm.googleapis.com.test/abc'],
        ['the name in the path', 'https://evil.test/fcm.googleapis.com/abc'],
        ['the name after an at sign', 'https://fcm.googleapis.com@evil.test/abc'],
        ['a user name', 'https://user@fcm.googleapis.com/abc'],
        ['a custom port', 'https://fcm.googleapis.com:8443/abc'],
        ['a host that only contains the name', 'https://notfcm.googleapis.com.test/abc'],
        ['a text that is not an address', 'not a url'],
        ['another scheme', 'file:///etc/passwd'],
    ])('refuses %s', (_label, endpoint) => {
        expect(parsePushEndpoint(endpoint))
            .toBeUndefined();
    });

    it('refuses an address that is too long', () => {
        const longEndpoint = `https://fcm.googleapis.com/${'a'.repeat(2100)}`;

        expect(parsePushEndpoint(longEndpoint))
            .toBeUndefined();
    });

    it('refuses a service host that only shares its ending with a known name', () => {
        expect(parsePushEndpoint('https://xpush.apple.com/abc'))
            .toBeUndefined();
        expect(parsePushEndpoint('https://web.push.apple.com/abc'))
            .toBeInstanceOf(URL);
    });
});
