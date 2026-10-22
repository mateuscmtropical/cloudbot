import { tool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { WatchStore } from '../store/WatchStore.ts';
import { checkWatchUrl } from './fetchWatchedPage.ts';

interface WatchToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

const WATCH_CREATE_TOOL_NAME = 'watch_create';
const WATCH_LIST_TOOL_NAME = 'watch_list';
const WATCH_DELETE_TOOL_NAME = 'watch_delete';
const WATCH_CREATE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WATCH_CREATE_TOOL_NAME}`;
const WATCH_LIST_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WATCH_LIST_TOOL_NAME}`;
const WATCH_DELETE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WATCH_DELETE_TOOL_NAME}`;
const WATCH_TOOL_FULL_NAMES = [
    WATCH_CREATE_TOOL_FULL_NAME,
    WATCH_LIST_TOOL_FULL_NAME,
    WATCH_DELETE_TOOL_FULL_NAME,
];

const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const DEFAULT_INTERVAL_MINUTES = 60;
const MAX_WATCHES_PER_BOT = 10;
const MAX_NAME_LENGTH = 60;
const MAX_KEYWORD_LENGTH = 100;
const MAX_URL_LENGTH = 2048;

const CREATE_DESCRIPTION = `Watch a web page for the owner: the page is checked on a schedule without you, and you are woken only when its text changes. Use it when the owner asks to be told about a page. Pass the page address, and a keyword when the owner wants only the lines with one word. When the owner does not say how often, use ${String(DEFAULT_INTERVAL_MINUTES)} minutes. The interval is ${String(MIN_INTERVAL_MINUTES)} to ${String(MAX_INTERVAL_MINUTES)} minutes. The first check only records the page, so no message comes for it. Private and local addresses are refused.`;
const LIST_DESCRIPTION = 'List your page watches with their ids, addresses and intervals.';
const DELETE_DESCRIPTION = 'Delete one of your page watches by id. It is not checked again.';

// The name and the address are shown and stored on one line, the same rule as the webhook route.
function hasLineBreak(text: string): boolean {
    return /[\r\n]/.test(text);
}

const CREATE_SHAPE = {
    name: z.string()
        .trim()
        .min(1)
        .max(MAX_NAME_LENGTH)
        .refine(value => !hasLineBreak(value), 'The name must be one line.'),
    url: z.string()
        .trim()
        .min(1)
        .max(MAX_URL_LENGTH)
        .refine(value => !hasLineBreak(value), 'The address must be one line.'),
    intervalMinutes: z.number()
        .optional(),
    keyword: z.string()
        .max(MAX_KEYWORD_LENGTH)
        .refine(value => !hasLineBreak(value), 'The keyword must be one line.')
        .optional(),
};
const LIST_SHAPE = {};
const ID_SHAPE = { id: z.string() };

function textResult(text: string, isError = false): WatchToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function isValidInterval(value: number | undefined): value is number {
    return value !== undefined && Number.isInteger(value) && value >= MIN_INTERVAL_MINUTES && value <= MAX_INTERVAL_MINUTES;
}

// An empty keyword means the whole page.
function readKeyword(keyword: string | undefined): string | undefined {
    const trimmedKeyword = keyword?.trim() ?? '';

    return trimmedKeyword === '' ? undefined : trimmedKeyword;
}

// The address is stored in the form the browser would use, so the same page is not kept twice under two spellings.
function normalizeUrl(text: string): string | undefined {
    try {
        return new URL(text).href;
    } catch {
        return undefined;
    }
}

type UrlChecker = (url: string) => Promise<string | undefined>;

// checkUrl refuses a private or invalid address before the watch is saved. Tests pass their own.
function createWatchTools(store: WatchStore, botId: string, checkUrl: UrlChecker = url => checkWatchUrl(url)): CloudbotTool[] {
    const createTool = tool(
        WATCH_CREATE_TOOL_NAME,
        CREATE_DESCRIPTION,
        CREATE_SHAPE,
        async (args): Promise<WatchToolResult> => {
            if (hasLineBreak(args.name) || hasLineBreak(args.url) || hasLineBreak(args.keyword ?? '')) {
                return textResult('The name, the address and the keyword must be one line.', true);
            }

            const intervalMinutes = args.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;

            if (!isValidInterval(intervalMinutes)) {
                return textResult(`The interval is ${String(MIN_INTERVAL_MINUTES)} to ${String(MAX_INTERVAL_MINUTES)} minutes.`, true);
            }

            const problem = await checkUrl(args.url);

            if (problem !== undefined) {
                return textResult(problem, true);
            }

            const storedUrl = normalizeUrl(args.url);

            if (storedUrl === undefined) {
                return textResult('The address is not a valid URL.', true);
            }

            const watch = await store.addWithLimit(botId, { name: args.name, url: storedUrl, intervalMinutes, keyword: readKeyword(args.keyword) }, MAX_WATCHES_PER_BOT);

            if (watch === undefined) {
                return textResult(`You can have at most ${String(MAX_WATCHES_PER_BOT)} page watches. Delete one first.`, true);
            }

            return textResult(`Watch created with id ${watch.id}. It is checked every ${String(intervalMinutes)} minutes, and you are woken when the text changes.`);
        },
    );
    const listTool = tool(
        WATCH_LIST_TOOL_NAME,
        LIST_DESCRIPTION,
        LIST_SHAPE,
        async (): Promise<WatchToolResult> => {
            const watches = await store.list(botId);

            if (watches.length === 0) {
                return textResult('You have no page watches.');
            }

            const lines = watches.map(watch => `- ${watch.id}: "${watch.name}" ${watch.url}, every ${String(watch.intervalMinutes)} minutes`);

            const listText = lines.join('\n');

            return textResult(listText);
        },
    );
    const deleteTool = tool(
        WATCH_DELETE_TOOL_NAME,
        DELETE_DESCRIPTION,
        ID_SHAPE,
        async (args): Promise<WatchToolResult> => {
            const isRemoved = await store.remove(botId, args.id);

            return isRemoved ? textResult('The page watch is deleted.') : textResult('You have no page watch with this id.', true);
        },
    );

    return [createTool, listTool, deleteTool] as CloudbotTool[];
}

export {
    DEFAULT_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
    MAX_WATCHES_PER_BOT,
    MIN_INTERVAL_MINUTES,
    WATCH_CREATE_TOOL_FULL_NAME,
    WATCH_DELETE_TOOL_FULL_NAME,
    WATCH_LIST_TOOL_FULL_NAME,
    WATCH_TOOL_FULL_NAMES,
    createWatchTools,
};
export type { UrlChecker, WatchToolResult };
