import { describe, expect, it } from 'vitest';

import type { BrowserToolResult } from './createBrowserTools.ts';
import { DESKTOP_TOOL_FULL_NAMES, createDesktopTools, describeDesktopTarget } from './createDesktopTools.ts';
import { DesktopInput } from './DesktopInput.ts';
import type { DesktopRunOptions } from './DesktopInput.ts';
import { ScreenHolder } from './ScreenHolder.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<BrowserToolResult>;

interface HelperRun {
    args: string[];
    options: DesktopRunOptions;
}

interface FakeDesktop {
    desktop: DesktopInput;
    runs: HelperRun[];
}

function createFakeDesktop(windowName = 'notes.txt - Editor'): FakeDesktop {
    const runs: HelperRun[] = [];
    const desktop = new DesktopInput({ command: '/usr/local/bin/cloudbot-desktop-input', args: [] }, (_command, args, options) => {
        runs.push({ args, options });

        if (args[0] === 'screenshot') {
            return Promise.resolve(Buffer.from('png'));
        }

        return Promise.resolve(Buffer.from(args[0] === 'window' ? windowName : ''));
    });

    return { desktop, runs };
}

function handlerOf(tools: ReturnType<typeof createDesktopTools>, name: string): ToolHandler {
    const found = tools.find(candidate => candidate.name === name);

    if (found === undefined) {
        throw new Error(`No tool named ${name}.`);
    }

    return found.handler as unknown as ToolHandler;
}

describe('createDesktopTools', () => {
    it('offers the desktop tools under the cloudbot server', () => {
        const { desktop } = createFakeDesktop();
        const tools = createDesktopTools(desktop);
        const fullNames = tools.map(candidate => `mcp__cloudbot__${candidate.name}`);

        expect(fullNames)
            .toEqual(DESKTOP_TOOL_FULL_NAMES);
    });

    it('clicks, types, presses keys and scrolls anywhere on the desktop and shows the screen', async () => {
        const { desktop, runs } = createFakeDesktop();
        const shownTimes = { count: 0 };
        const tools = createDesktopTools(desktop, undefined, new ScreenHolder(), () => {
            shownTimes.count += 1;
        });

        await handlerOf(tools, 'desktop_click')({ x: 40, y: 780, double: true }, {});
        await handlerOf(tools, 'desktop_type')({ text: 'code .' }, {});
        await handlerOf(tools, 'desktop_key')({ keys: 'Return' }, {});
        await handlerOf(tools, 'desktop_scroll')({ x: 600, y: 400, direction: 'up' }, {});

        expect(runs.map(run => run.args))
            .toEqual([['click', '40', '780', '1', '2'], ['type'], ['key', 'Return'], ['scroll', '600', '400', 'up', '3']]);
        expect(runs[1]?.options.input)
            .toBe('code .');
        expect(shownTimes.count)
            .toBe(4);
    });

    it('returns the screenshot as an image and shares it when asked', async () => {
        const { desktop } = createFakeDesktop();
        const shared: string[] = [];
        const tools = createDesktopTools(desktop, (pngBase64) => {
            shared.push(pngBase64);

            return Promise.resolve();
        });

        const result = await handlerOf(tools, 'desktop_screenshot')({ showOwner: true }, {});

        expect(result.content[0])
            .toEqual({ type: 'image', data: Buffer.from('png')
                .toString('base64'), mimeType: 'image/png' });
        expect(shared)
            .toHaveLength(1);
    });

    it('refuses every desktop action while the owner holds the screen', async () => {
        const { desktop, runs } = createFakeDesktop();
        const screen = new ScreenHolder();
        const tools = createDesktopTools(desktop, undefined, screen);

        screen.giveToPerson();

        const results = await Promise.all(tools.map((candidate) => {
            const handler = candidate.handler as unknown as ToolHandler;

            return handler({ x: 1, y: 1, text: 'a', keys: 'Return', direction: 'down' }, {});
        }));

        expect(results.every(result => result.isError === true))
            .toBe(true);
        expect(runs)
            .toEqual([]);
    });

    it('names the window a click, a key or typing hits for the review', async () => {
        const { desktop, runs } = createFakeDesktop('Checkout - Chromium');

        await expect(describeDesktopTarget(desktop, { toolName: 'mcp__cloudbot__desktop_click', input: { x: 7, y: 8 } }))
            .resolves.toBe('Desktop window at the point: "Checkout - Chromium"');
        await expect(describeDesktopTarget(desktop, { toolName: 'mcp__cloudbot__desktop_type', input: { text: 'hi' } }))
            .resolves.toBe('Desktop window with the focus: "Checkout - Chromium"');
        await expect(describeDesktopTarget(desktop, { toolName: 'mcp__cloudbot__desktop_screenshot', input: {} }))
            .resolves.toBeUndefined();
        expect(runs.map(run => run.args))
            .toEqual([['window', '7', '8'], ['window']]);
    });

    it('says when the point is on the bare desktop or the window cannot be read', async () => {
        const { desktop } = createFakeDesktop('');
        const failing = new DesktopInput({ command: 'helper', args: [] }, () => Promise.reject(new Error('down')));

        await expect(describeDesktopTarget(desktop, { toolName: 'mcp__cloudbot__desktop_click', input: { x: 1, y: 1 } }))
            .resolves.toBe('Desktop window at the point: none, the bare desktop');
        await expect(describeDesktopTarget(failing, { toolName: 'mcp__cloudbot__desktop_key', input: { keys: 'Return' } }))
            .resolves.toBe('unknown');
    });
});
