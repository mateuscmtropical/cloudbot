import { afterEach, describe, expect, it, vi } from 'vitest';

import { CdpConnection, CdpError } from './CdpConnection.ts';
import { FakeCdpSocket, createFakeSocketFactory } from './testCdp.ts';

afterEach(() => {
    vi.useRealTimers();
});

describe('CdpConnection', () => {
    it('sends a call and resolves with its result', async () => {
        const { factory, sockets } = createFakeSocketFactory(() => ({ result: { frameId: 'main' } }));
        const connection = await CdpConnection.open('ws://page', factory);

        await expect(connection.call('Page.navigate', { url: 'https://example.com/' })).resolves.toEqual({ frameId: 'main' });
        expect(sockets[0]?.sent[0])
            .toEqual({ id: 1, method: 'Page.navigate', params: { url: 'https://example.com/' } });
    });

    it('rejects with the browser error message', async () => {
        const { factory } = createFakeSocketFactory(() => ({ error: { message: 'Cannot navigate' } }));
        const connection = await CdpConnection.open('ws://page', factory);

        await expect(connection.call('Page.navigate')).rejects.toThrow('Cannot navigate');
    });

    it('rejects when the socket cannot open', async () => {
        const { factory } = createFakeSocketFactory(() => undefined, true);

        await expect(CdpConnection.open('ws://page', factory)).rejects.toBeInstanceOf(CdpError);
    });

    it('rejects a call that gets no answer in time', async () => {
        const { factory } = createFakeSocketFactory(() => undefined);
        const connection = await CdpConnection.open('ws://page', factory);

        vi.useFakeTimers();

        const pendingCall = connection.call('Page.captureScreenshot', {}, 1000);

        vi.advanceTimersByTime(1000);

        await expect(pendingCall).rejects.toThrow('did not answer Page.captureScreenshot in time');
    });

    it('rejects open calls when the socket closes', async () => {
        const { factory, sockets } = createFakeSocketFactory(() => undefined);
        const connection = await CdpConnection.open('ws://page', factory);
        const pendingCall = connection.call('Runtime.evaluate');

        sockets[0]?.close();

        await expect(pendingCall).rejects.toThrow('closed');
        await expect(connection.call('Runtime.evaluate')).rejects.toThrow('closed');
    });

    it('ignores events, unknown ids and text that is not JSON', async () => {
        const { factory, sockets } = createFakeSocketFactory(() => ({ result: 'done' }));
        const connection = await CdpConnection.open('ws://page', factory);
        const socket = sockets[0];

        socket?.emit('message', { data: '{"method":"Page.loadEventFired"}' });
        socket?.emit('message', { data: '{"id":99,"result":"other"}' });
        socket?.emit('message', { data: 'not json' });
        socket?.emit('message', { data: 42 });

        await expect(connection.call('Runtime.evaluate')).resolves.toBe('done');
    });

    it('passes events to the listener', async () => {
        const { factory, sockets } = createFakeSocketFactory(() => undefined);
        const connection = await CdpConnection.open('ws://page', factory);
        const events: [string, unknown][] = [];

        connection.onEvent((method, params) => {
            events.push([method, params]);
        });
        sockets[0]?.emit('message', { data: '{"method":"Page.javascriptDialogOpening","params":{"message":"hi"}}' });

        expect(events)
            .toEqual([['Page.javascriptDialogOpening', { message: 'hi' }]]);
    });

    it('gives up when the socket does not open in time', async () => {
        vi.useFakeTimers();

        const sockets: FakeCdpSocket[] = [];
        const opening = CdpConnection.open('ws://page', () => {
            const socket = new FakeCdpSocket(() => undefined);

            sockets.push(socket);

            return socket;
        }, 1000);
        const expectation = expect(opening).rejects.toThrow('did not accept the connection in time');

        await vi.advanceTimersByTimeAsync(1000);
        await expectation;
        expect(sockets[0]?.isClosed)
            .toBe(true);
    });
});
