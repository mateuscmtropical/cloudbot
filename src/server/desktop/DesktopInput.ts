import { execFile } from 'node:child_process';

import { buildDesktopEnvironment } from './DesktopSupervisor.ts';
import type { DesktopCommand } from './DesktopSupervisor.ts';

interface DesktopRunOptions {
    // Sent on stdin. Typed text goes this way, so it is never read as an option.
    input?: string;
    timeoutMs: number;
}

// Runs the helper and returns its stdout. It rejects when the helper fails or takes too long.
type DesktopInputRunner = (command: string, args: string[], options: DesktopRunOptions) => Promise<Buffer>;

type MouseButton = 'left' | 'middle' | 'right';
type ScrollDirection = 'up' | 'down';

// docker/cloudbot-desktop-input in the image. The server runs it as the agent user, like the desktop.
const DESKTOP_INPUT_PATH = '/usr/local/bin/cloudbot-desktop-input';
const MOUSE_BUTTON_NUMBERS: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' };
// One key or a chord of X key names, such as Return, ctrl+l or alt+Tab. The helper checks the same pattern.
const KEY_COMBO_PATTERN = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;
const MAX_KEY_COMBO_LENGTH = 64;
const MAX_TYPE_LENGTH = 2_000;
const MAX_SCROLL_STEPS = 30;
const RUN_TIMEOUT_MS = 10_000;
// The helper types one character about every 12 ms, so long text gets more time.
const TYPE_MS_PER_CHARACTER = 20;
// A PNG of a 1920 by 1920 screen fits, and a helper that prints without end is cut off.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_WINDOW_NAME_LENGTH = 200;
// Control characters in a window name could break the lines of the review prompt.
const CONTROL_CHARACTERS_PATTERN = /\p{Cc}/gu;
const NOT_RUNNING_MESSAGE = 'The desktop did not answer. Try again in a few seconds.';

// A failure with a message for the model.
class DesktopError extends Error {}

function runDesktopHelper(command: string, args: string[], options: DesktopRunOptions): Promise<Buffer> {
    const environment = buildDesktopEnvironment();

    return new Promise((resolve, reject) => {
        const child = execFile(command, args, { encoding: 'buffer', maxBuffer: MAX_OUTPUT_BYTES, timeout: options.timeoutMs, env: environment }, (error, stdout) => {
            if (error) {
                reject(new Error('The desktop helper failed.'));

                return;
            }

            resolve(stdout);
        });

        child.stdin?.end(options.input ?? '');
    });
}

function cleanWindowName(output: Buffer): string {
    const text = output.toString('utf8')
        .replace(CONTROL_CHARACTERS_PATTERN, ' ')
        .trim();

    return text.slice(0, MAX_WINDOW_NAME_LENGTH);
}

// Sees and drives the whole desktop of the bot: the screen, the mouse and the keyboard, in every app.
class DesktopInput {
    private readonly command: DesktopCommand;
    private readonly run: DesktopInputRunner;

    constructor(command: DesktopCommand, run: DesktopInputRunner = runDesktopHelper) {
        this.command = command;
        this.run = run;
    }

    // A PNG of the whole screen, as base64.
    async screenshot(): Promise<string> {
        const output = await this.runAction(['screenshot']);

        return output.toString('base64');
    }

    async click(pointX: number, pointY: number, button: MouseButton, count: 1 | 2): Promise<void> {
        await this.runAction(['click', String(pointX), String(pointY), MOUSE_BUTTON_NUMBERS[button], String(count)]);
    }

    async scroll(pointX: number, pointY: number, direction: ScrollDirection, steps: number): Promise<void> {
        if (!Number.isInteger(steps) || steps < 1 || steps > MAX_SCROLL_STEPS) {
            throw new DesktopError(`Scroll between 1 and ${String(MAX_SCROLL_STEPS)} steps.`);
        }

        await this.runAction(['scroll', String(pointX), String(pointY), direction, String(steps)]);
    }

    async typeText(text: string): Promise<void> {
        if (text.length === 0 || text.length > MAX_TYPE_LENGTH) {
            throw new DesktopError(`Type between 1 and ${String(MAX_TYPE_LENGTH)} characters at a time.`);
        }

        const timeoutMs = RUN_TIMEOUT_MS + (text.length * TYPE_MS_PER_CHARACTER);

        await this.runAction(['type'], text, timeoutMs);
    }

    async pressKey(combo: string): Promise<void> {
        if (combo.length > MAX_KEY_COMBO_LENGTH || !KEY_COMBO_PATTERN.test(combo)) {
            throw new DesktopError('Give one key or a chord of X key names joined by +, such as Return, ctrl+l or alt+Tab.');
        }

        await this.runAction(['key', combo]);
    }

    // The name of the top window at a point. Empty when the point is on the bare desktop.
    async windowAt(pointX: number, pointY: number): Promise<string> {
        const output = await this.runAction(['window', String(pointX), String(pointY)]);

        return cleanWindowName(output);
    }

    // The name of the window that has the keyboard focus. Empty when none has it.
    async focusedWindow(): Promise<string> {
        const output = await this.runAction(['window']);

        return cleanWindowName(output);
    }

    private async runAction(actionArgs: string[], input?: string, timeoutMs = RUN_TIMEOUT_MS): Promise<Buffer> {
        const args = [...this.command.args, ...actionArgs];
        const options: DesktopRunOptions = input === undefined ? { timeoutMs } : { input, timeoutMs };

        try {
            return await this.run(this.command.command, args, options);
        } catch {
            throw new DesktopError(NOT_RUNNING_MESSAGE);
        }
    }
}

export { DESKTOP_INPUT_PATH, DesktopError, DesktopInput, KEY_COMBO_PATTERN, MAX_KEY_COMBO_LENGTH, MAX_SCROLL_STEPS, MAX_TYPE_LENGTH };
export type { DesktopInputRunner, DesktopRunOptions, MouseButton, ScrollDirection };
