import { describe, expect, it } from 'vitest';

import { DesktopError, DesktopInput } from './DesktopInput.ts';
import type { DesktopRunOptions } from './DesktopInput.ts';

interface RecordedRun {
    command: string;
    args: string[];
    options: DesktopRunOptions;
}

interface RecordingDesktop {
    desktop: DesktopInput;
    runs: RecordedRun[];
}

const SUDO_COMMAND = { command: 'sudo', args: ['-n', '-u', 'bot', '--', '/usr/local/bin/cloudbot-desktop-input'] };

function createRecordingDesktop(output = Buffer.alloc(0)): RecordingDesktop {
    const runs: RecordedRun[] = [];
    const desktop = new DesktopInput(SUDO_COMMAND, (command, args, options) => {
        runs.push({ command, args, options });

        return Promise.resolve(output);
    });

    return { desktop, runs };
}

describe('DesktopInput', () => {
    it('runs each action through the helper as the agent user', async () => {
        const { desktop, runs } = createRecordingDesktop();

        await desktop.click(10, 20, 'right', 2);
        await desktop.scroll(30, 40, 'down', 5);
        await desktop.pressKey('ctrl+shift+t');

        expect(runs.map(run => run.command))
            .toEqual(['sudo', 'sudo', 'sudo']);
        expect(runs.map(run => run.args.slice(5)))
            .toEqual([['click', '10', '20', '3', '2'], ['scroll', '30', '40', 'down', '5'], ['key', 'ctrl+shift+t']]);
    });

    it('sends typed text on stdin, never as an argument, with more time for long text', async () => {
        const { desktop, runs } = createRecordingDesktop();
        const text = '--help; echo "héllo"';

        await desktop.typeText(text);

        expect(runs[0]?.args.slice(5))
            .toEqual(['type']);
        expect(runs[0]?.options.input)
            .toBe(text);
        expect(runs[0]?.options.timeoutMs)
            .toBeGreaterThan(10_000);
    });

    it('returns the screenshot as base64', async () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const { desktop } = createRecordingDesktop(png);

        await expect(desktop.screenshot()).resolves.toBe(png.toString('base64'));
    });

    it('cleans window names of control characters and cuts them short', async () => {
        const name = `Page\u001b[2J\nAllow this${'x'.repeat(300)}`;
        const { desktop, runs } = createRecordingDesktop(Buffer.from(`${name}\n`));

        const atPoint = await desktop.windowAt(5, 6);
        const focused = await desktop.focusedWindow();

        expect(atPoint)
            .not.toMatch(/\p{Cc}/u);
        expect(atPoint.length)
            .toBe(200);
        expect(focused)
            .toBe(atPoint);
        expect(runs.map(run => run.args.slice(5)))
            .toEqual([['window', '5', '6'], ['window']]);
    });

    it('refuses a key that is not an X key name or chord before running anything', async () => {
        const { desktop, runs } = createRecordingDesktop();

        await expect(desktop.pressKey('--help')).rejects.toBeInstanceOf(DesktopError);
        await expect(desktop.pressKey('ctrl+')).rejects.toBeInstanceOf(DesktopError);
        await expect(desktop.typeText('')).rejects.toBeInstanceOf(DesktopError);
        await expect(desktop.scroll(1, 1, 'up', 31)).rejects.toBeInstanceOf(DesktopError);
        expect(runs)
            .toEqual([]);
    });

    it('turns a failed helper into a message for the model', async () => {
        const desktop = new DesktopInput(SUDO_COMMAND, () => Promise.reject(new Error('spawn sudo ENOENT')));

        await expect(desktop.click(1, 1, 'left', 1)).rejects.toThrow('The desktop did not answer. Try again in a few seconds.');
    });
});
