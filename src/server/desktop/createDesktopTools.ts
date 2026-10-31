import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { ToolCall } from '../agent/AgentRunner.ts';
import { SCREEN_HEIGHT, SCREEN_WIDTH, shareIfAsked } from './createBrowserTools.ts';
import type { BrowserToolResult, ScreenshotShareHandler } from './createBrowserTools.ts';
import { DesktopError, KEY_COMBO_PATTERN, MAX_KEY_COMBO_LENGTH, MAX_SCROLL_STEPS, MAX_TYPE_LENGTH } from './DesktopInput.ts';
import type { DesktopInput } from './DesktopInput.ts';
import { SCREEN_HELD_BY_PERSON_MESSAGE } from './ScreenHolder.ts';
import type { ScreenHolder } from './ScreenHolder.ts';

const DESKTOP_TOOL_PREFIX = 'desktop_';
const DESKTOP_TOOL_NAMES = ['screenshot', 'click', 'type', 'key', 'scroll'].map(name => `${DESKTOP_TOOL_PREFIX}${name}`);
const DESKTOP_TOOL_FULL_NAMES = DESKTOP_TOOL_NAMES.map(name => `mcp__${PROFILE_SERVER_NAME}__${name}`);
const CLICK_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${DESKTOP_TOOL_PREFIX}click`;
// Typing and keys go to the window with the focus. The review is told its name.
const FOCUS_TOOL_NAMES = ['type', 'key'].map(name => `mcp__${PROFILE_SERVER_NAME}__${DESKTOP_TOOL_PREFIX}${name}`);
const FOCUS_TOOL_FULL_NAMES = new Set(FOCUS_TOOL_NAMES);
const DEFAULT_SCROLL_STEPS = 3;

const X_SHAPE = z.number()
    .int()
    .min(0)
    .max(SCREEN_WIDTH - 1);
const Y_SHAPE = z.number()
    .int()
    .min(0)
    .max(SCREEN_HEIGHT - 1);
const SCREENSHOT_SHAPE = {
    showOwner: z.boolean()
        .optional(),
};
const CLICK_SHAPE = {
    x: X_SHAPE,
    y: Y_SHAPE,
    button: z.enum(['left', 'middle', 'right'])
        .optional(),
    double: z.boolean()
        .optional(),
};
const TYPE_SHAPE = {
    text: z.string()
        .min(1)
        .max(MAX_TYPE_LENGTH),
};
const KEY_SHAPE = {
    keys: z.string()
        .max(MAX_KEY_COMBO_LENGTH)
        .regex(KEY_COMBO_PATTERN),
};
const SCROLL_SHAPE = {
    x: X_SHAPE,
    y: Y_SHAPE,
    direction: z.enum(['up', 'down']),
    steps: z.number()
        .int()
        .min(1)
        .max(MAX_SCROLL_STEPS)
        .optional(),
};

function textResult(text: string, isError = false): BrowserToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

// A DesktopError carries a message for the model. Other errors stay generic.
async function runDesktopAction(screen: ScreenHolder | undefined, action: () => Promise<BrowserToolResult>): Promise<BrowserToolResult> {
    // The bot never acts while a person has the screen.
    if (screen?.isPersonHolding === true) {
        return textResult(SCREEN_HELD_BY_PERSON_MESSAGE, true);
    }

    try {
        return await action();
    } catch (error: unknown) {
        const message = error instanceof DesktopError ? error.message : 'The desktop action failed.';

        return textResult(message, true);
    }
}

function readNumber(input: unknown, field: string): number | undefined {
    const value: unknown = typeof input === 'object' && input !== null ? Reflect.get(input, field) : undefined;

    return typeof value === 'number' ? value : undefined;
}

function quoteWindowName(name: string): string {
    return name === '' ? 'none, the bare desktop' : JSON.stringify(name);
}

// The window a click, a key or typing hits, for the approval review. Undefined for other tools.
async function describeDesktopTarget(desktop: DesktopInput, call: ToolCall): Promise<string | undefined> {
    const isClick = call.toolName === CLICK_TOOL_FULL_NAME;

    if (!isClick && !FOCUS_TOOL_FULL_NAMES.has(call.toolName)) {
        return undefined;
    }

    try {
        if (isClick) {
            const name = await desktop.windowAt(readNumber(call.input, 'x') ?? 0, readNumber(call.input, 'y') ?? 0);

            return `Desktop window at the point: ${quoteWindowName(name)}`;
        }

        const name = await desktop.focusedWindow();

        return `Desktop window with the focus: ${quoteWindowName(name)}`;
    } catch {
        return 'unknown';
    }
}

// onAction runs after an action that may change the screen, so the owner can be shown the live screen.
function createDesktopTools(desktop: DesktopInput, shareScreenshot?: ScreenshotShareHandler, screen?: ScreenHolder, onAction?: () => void): CloudbotTool[] {
    const screenshotTool = tool(
        `${DESKTOP_TOOL_PREFIX}screenshot`,
        `Take a screenshot of your whole desktop, with every open window and the panel at the bottom. The image is ${String(SCREEN_WIDTH)} by ${String(SCREEN_HEIGHT)} pixels, and its pixels are the coordinates for the other desktop_ tools. Set showOwner to true to also show it to the owner in the chat.`,
        SCREENSHOT_SHAPE,
        args => runDesktopAction(screen, async () => {
            const data = await desktop.screenshot();
            const shareNote = await shareIfAsked(data, args.showOwner, shareScreenshot);
            const noteContent = shareNote === '' ? [] : [{ type: 'text' as const, text: shareNote }];

            return { content: [{ type: 'image', data, mimeType: 'image/png' }, ...noteContent] };
        }),
    );
    const clickTool = tool(
        `${DESKTOP_TOOL_PREFIX}click`,
        'Click a point of your desktop, in screenshot pixels, in any app. Set double to true for a double click, and button to right for a context menu. Open apps with the Apps button at the bottom left.',
        CLICK_SHAPE,
        args => runDesktopAction(screen, async () => {
            const button = args.button ?? 'left';

            await desktop.click(args.x, args.y, button, args.double === true ? 2 : 1);
            onAction?.();

            return textResult(`Clicked ${button} at ${String(args.x)}, ${String(args.y)}. Take a screenshot to see the result.`);
        }),
    );
    const typeTool = tool(
        `${DESKTOP_TOOL_PREFIX}type`,
        'Type text into the window that has the focus on your desktop, such as a terminal or an editor. Click the window first.',
        TYPE_SHAPE,
        args => runDesktopAction(screen, async () => {
            await desktop.typeText(args.text);
            onAction?.();

            return textResult('Typed the text.');
        }),
    );
    const keyTool = tool(
        `${DESKTOP_TOOL_PREFIX}key`,
        'Press one key or a chord in the window that has the focus on your desktop. Use X key names joined by +, such as Return, Escape, Tab, BackSpace, Up, F5, ctrl+c, ctrl+shift+t or alt+Tab.',
        KEY_SHAPE,
        args => runDesktopAction(screen, async () => {
            await desktop.pressKey(args.keys);
            onAction?.();

            return textResult(`Pressed ${args.keys}.`);
        }),
    );
    const scrollTool = tool(
        `${DESKTOP_TOOL_PREFIX}scroll`,
        `Turn the mouse wheel over a point of your desktop, up or down, by 1 to ${String(MAX_SCROLL_STEPS)} steps. The default is ${String(DEFAULT_SCROLL_STEPS)}.`,
        SCROLL_SHAPE,
        args => runDesktopAction(screen, async () => {
            const steps = args.steps ?? DEFAULT_SCROLL_STEPS;

            await desktop.scroll(args.x, args.y, args.direction, steps);
            onAction?.();

            return textResult(`Scrolled ${args.direction} by ${String(steps)} steps.`);
        }),
    );

    return [screenshotTool, clickTool, typeTool, keyTool, scrollTool] as CloudbotTool[];
}

export { DESKTOP_TOOL_FULL_NAMES, createDesktopTools, describeDesktopTarget };
