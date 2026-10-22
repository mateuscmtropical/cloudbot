import { describe, expect, it } from 'vitest';

import { CdpConnection } from './CdpConnection.ts';
import { ScreenRecorder, buildRecorderScript, describeRecordedSteps } from './ScreenRecorder.ts';
import { createFakeSocketFactory } from './testCdp.ts';
import type { FakeCdpSocket } from './testCdp.ts';

async function startRecording(): Promise<{ recorder: ScreenRecorder; socket: FakeCdpSocket; bindingName: string }> {
    const { factory, sockets } = createFakeSocketFactory(() => ({ result: {} }));
    const page = await CdpConnection.open('ws://page', factory);
    const recorder = await ScreenRecorder.start(page);
    const socket = sockets[0];
    const bindingCall = socket?.sent.find(call => call.method === 'Runtime.addBinding');
    const bindingName = String(bindingCall?.params.name);

    if (socket === undefined) {
        throw new Error('No socket');
    }

    return { recorder, socket, bindingName };
}

function emitEvent(socket: FakeCdpSocket, method: string, params: unknown): void {
    socket.emit('message', { data: JSON.stringify({ method, params }) });
}

function report(socket: FakeCdpSocket, name: string, step: unknown): void {
    emitEvent(socket, 'Runtime.bindingCalled', { name, payload: JSON.stringify(step), executionContextId: 1 });
}

describe('ScreenRecorder', () => {
    it('adds its binding and script to the page and runs the script on the open page too', async () => {
        const { socket, bindingName } = await startRecording();
        const methods = socket.sent.map(call => call.method);

        expect(bindingName)
            .toMatch(/^cloudbotRecord_[0-9a-f]{16}$/);
        expect(methods)
            .toEqual(['Runtime.enable', 'Page.enable', 'Runtime.addBinding', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate']);
    });

    it('records page opens without query or fragment, clicks, typed text, secret fields and submits', async () => {
        const { recorder, socket, bindingName } = await startRecording();

        emitEvent(socket, 'Page.frameNavigated', { frame: { id: 'main', url: 'https://shop.example.test/login?token=abc#top' } });
        emitEvent(socket, 'Page.frameNavigated', { frame: { id: 'ad', parentId: 'main', url: 'https://ads.example.test/' } });
        report(socket, bindingName, { kind: 'type', field: 'Email', text: 'ana@example.test' });
        report(socket, bindingName, { kind: 'secret', field: 'Password' });
        report(socket, bindingName, { kind: 'click', target: 'Sign in' });
        report(socket, bindingName, { kind: 'submit', target: 'form' });
        const steps = recorder.stop();

        expect(steps)
            .toEqual([
                { kind: 'open', url: 'https://shop.example.test/login' },
                { kind: 'type', field: 'Email', text: 'ana@example.test' },
                { kind: 'secret', field: 'Password' },
                { kind: 'click', target: 'Sign in' },
                { kind: 'submit', target: 'form' },
            ]);
        expect(socket.isClosed)
            .toBe(true);
    });

    it('masks a card number typed into a plain field, and drops calls of another binding and unknown kinds', async () => {
        const { recorder, socket, bindingName } = await startRecording();

        report(socket, bindingName, { kind: 'type', field: 'Notes', text: 'card 4111 1111 1111 1111' });
        report(socket, 'someOtherBinding', { kind: 'click', target: 'Forged' });
        report(socket, bindingName, { kind: 'run', target: 'x' });
        emitEvent(socket, 'Runtime.bindingCalled', { name: bindingName, payload: 'not json' });
        const steps = recorder.stop();

        expect(steps)
            .toHaveLength(1);
        expect(JSON.stringify(steps))
            .not.toContain('4111 1111 1111 1111');
    });

    it('records nothing after stop, and at most 200 steps', async () => {
        const { recorder, socket, bindingName } = await startRecording();

        Array.from({ length: 205 }, (_unused, index) => index)
            .forEach((index) => {
                report(socket, bindingName, { kind: 'click', target: `Button ${String(index)}` });
            });
        const steps = recorder.stop();

        report(socket, bindingName, { kind: 'click', target: 'Late' });

        expect(steps)
            .toHaveLength(200);
        expect(recorder.stop())
            .toHaveLength(200);
    });

    it('closes the page connection when the start fails', async () => {
        const { factory, sockets } = createFakeSocketFactory(call => (call.method === 'Runtime.addBinding' ? { error: { message: 'no' } } : { result: {} }));
        const page = await CdpConnection.open('ws://page', factory);

        await expect(ScreenRecorder.start(page))
            .rejects.toThrow();
        expect(sockets[0]?.isClosed)
            .toBe(true);
    });

    it('masks card numbers in labels too', async () => {
        const { recorder, socket, bindingName } = await startRecording();

        report(socket, bindingName, { kind: 'click', target: 'Pay with 4111 1111 1111 1111' });
        const steps = recorder.stop();

        expect(JSON.stringify(steps))
            .not.toContain('4111 1111 1111 1111');
    });

    it('names the binding and a flag of its own in the page script, and never labels a field by its value', () => {
        const script = buildRecorderScript('cloudbotRecord_abc');

        expect(script)
            .toContain('window["cloudbotRecord_abc"]');
        expect(script)
            .toContain('"cloudbotRecord_abc_on"');
        expect(script)
            .toContain('isButtonInput ? element.value');
        expect(script)
            .toContain('type === \'password\'');
    });
});

describe('describeRecordedSteps', () => {
    it('numbers the steps, quotes page text and tells the bot to ask for a saved secret', () => {
        const text = describeRecordedSteps([
            { kind: 'open', url: 'https://shop.example.test/login' },
            { kind: 'type', field: 'Email', text: 'ana@example.test' },
            { kind: 'secret', field: 'Password' },
            { kind: 'click', target: 'Sign "in"' },
        ]);

        expect(text)
            .toBe([
                '1. Opened "https://shop.example.test/login"',
                '2. Typed "ana@example.test" into "Email"',
                '3. Typed a secret into "Password" (not recorded, ask for the saved secret)',
                '4. Clicked "Sign \\"in\\""',
            ].join('\n'));
        expect(describeRecordedSteps([]))
            .toBe('Nothing was recorded.');
    });
});
