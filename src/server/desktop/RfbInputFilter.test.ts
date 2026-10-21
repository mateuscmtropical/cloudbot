import { describe, expect, it } from 'vitest';

import { RfbInputFilter, RfbStreamError } from './RfbInputFilter.ts';

const HANDSHAKE = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]);
const UPDATE_REQUEST = Buffer.from([3, 0, 0, 0, 0, 0, 5, 0, 5, 0]);
const KEY_DOWN = Buffer.from([4, 1, 0, 0, 0, 0, 0, 97]);
const POINTER = Buffer.from([5, 1, 0, 10, 0, 10]);
const CUT_TEXT = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from('abc')]);
const SET_ENCODINGS = Buffer.from([2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1]);

function startedFilter(isAllowed: () => boolean): RfbInputFilter {
    const filter = new RfbInputFilter(isAllowed);

    filter.filter(HANDSHAKE);

    return filter;
}

describe('RfbInputFilter', () => {
    it('passes the handshake', () => {
        const filter = new RfbInputFilter(() => false);

        expect(filter.filter(HANDSHAKE))
            .toEqual(HANDSHAKE);
    });

    it('drops key, pointer and clipboard messages while input is not allowed', () => {
        const filter = startedFilter(() => false);
        const output = filter.filter(Buffer.concat([UPDATE_REQUEST, KEY_DOWN, POINTER, CUT_TEXT, SET_ENCODINGS]));

        expect(output)
            .toEqual(Buffer.concat([UPDATE_REQUEST, SET_ENCODINGS]));
    });

    it('passes input messages while input is allowed', () => {
        const filter = startedFilter(() => true);
        const all = Buffer.concat([KEY_DOWN, POINTER, CUT_TEXT]);

        expect(filter.filter(all))
            .toEqual(all);
    });

    it('decides for each message when the holder changes', () => {
        let isAllowed = false;
        const filter = startedFilter(() => isAllowed);

        expect(filter.filter(POINTER))
            .toHaveLength(0);

        isAllowed = true;

        expect(filter.filter(POINTER))
            .toEqual(POINTER);
    });

    it('joins a message that arrives in pieces', () => {
        const filter = startedFilter(() => true);

        expect(filter.filter(CUT_TEXT.subarray(0, 5)))
            .toHaveLength(0);
        expect(filter.filter(CUT_TEXT.subarray(5, 9)))
            .toHaveLength(0);
        expect(filter.filter(CUT_TEXT.subarray(9)))
            .toEqual(CUT_TEXT);
    });

    it('drops a clipboard message that arrives in pieces', () => {
        const filter = startedFilter(() => false);

        expect(filter.filter(CUT_TEXT.subarray(0, 9)))
            .toHaveLength(0);
        expect(filter.filter(Buffer.concat([CUT_TEXT.subarray(9), UPDATE_REQUEST])))
            .toEqual(UPDATE_REQUEST);
    });

    it('handles a handshake that arrives together with messages', () => {
        const filter = new RfbInputFilter(() => false);

        expect(filter.filter(Buffer.concat([HANDSHAKE, KEY_DOWN, UPDATE_REQUEST])))
            .toEqual(Buffer.concat([HANDSHAKE, UPDATE_REQUEST]));
    });

    it('refuses a message type it cannot frame', () => {
        const filter = startedFilter(() => false);

        expect(() => filter.filter(Buffer.from([255, 0, 0, 0])))
            .toThrow(RfbStreamError);
    });

    it('refuses a clipboard message that is far too large', () => {
        const filter = startedFilter(() => false);
        const header = Buffer.from([6, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);

        expect(() => filter.filter(Buffer.concat([header, Buffer.alloc(3 * 1024 * 1024)])))
            .toThrow(RfbStreamError);
    });
});
