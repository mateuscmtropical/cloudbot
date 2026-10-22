import { isIP } from 'node:net';

import { tool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { BrowserAllowRecord, BrowserAllowStore } from '../store/BrowserAllowStore.ts';
import { isAllowablePrivateAddress, isPublicAddress, readLocalAddresses } from '../watches/publicAddress.ts';
import { normalizeHost } from './browserHost.ts';

interface TextContent {
    type: 'text';
    text: string;
}

interface BrowserAllowToolResult {
    [key: string]: unknown;
    content: TextContent[];
    isError?: boolean;
}

type BrowserAllowStoreOperations = Pick<BrowserAllowStore, 'add' | 'list' | 'remove'>;

const ALLOW_TOOL_NAME = 'browser_allow_host';
const LIST_TOOL_NAME = 'browser_allowed_hosts';
const REMOVE_TOOL_NAME = 'browser_remove_host';
const BROWSER_ALLOW_TOOL_FULL_NAMES = [ALLOW_TOOL_NAME, LIST_TOOL_NAME, REMOVE_TOOL_NAME]
    .map(name => `mcp__${PROFILE_SERVER_NAME}__${name}`);
const MAX_HOST_LENGTH = 253;
const MAX_PORT = 65_535;
const ANY_PORT = 0;

const ALLOW_DESCRIPTION = 'Allow the browser to reach a private host, such as a name on the owner\'s network or a 10.x or 192.168.x address, when the owner asks for it. The owner must approve this first. Pass the host, and a port when the owner names one. Without a port every port of the host is allowed. Public addresses never need this.';
const LIST_DESCRIPTION = 'List the private hosts the owner allowed the browser to reach, with their ids.';
const REMOVE_DESCRIPTION = 'Remove a private host from the browser allow list by id. The browser refuses it again.';

const ALLOW_SHAPE = {
    host: z.string()
        .trim()
        .min(1)
        .max(MAX_HOST_LENGTH),
    port: z.number()
        .int()
        .min(1)
        .max(MAX_PORT)
        .optional(),
};
const LIST_SHAPE = {};
const REMOVE_SHAPE = {
    id: z.string()
        .min(1),
};

function textResult(text: string, isError = false): BrowserAllowToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

// Loopback, localhost, this machine, unspecified, link-local and the metadata addresses can never be allowed.
// A public address needs no allow, so it is not refused here.
function isNeverAllowedHost(host: string): boolean {
    if (host === 'localhost' || host.endsWith('.localhost')) {
        return true;
    }

    if (isIP(host) === 0) {
        return false;
    }

    const localAddresses = readLocalAddresses();

    return !isPublicAddress(host, localAddresses) && !isAllowablePrivateAddress(host, localAddresses);
}

// The port wording shared by the allow and the list answers.
function describePort(port: number): string {
    return port === ANY_PORT ? 'every port' : `port ${String(port)}`;
}

function createBrowserAllowTools(store: BrowserAllowStoreOperations): CloudbotTool[] {
    const allowTool = tool(
        ALLOW_TOOL_NAME,
        ALLOW_DESCRIPTION,
        ALLOW_SHAPE,
        async (args): Promise<BrowserAllowToolResult> => {
            const host = normalizeHost(args.host);

            if (host === undefined) {
                return textResult('That is not a host name or an IP address.', true);
            }

            if (isNeverAllowedHost(host)) {
                return textResult('The browser never reaches this host, such as localhost, loopback, this machine or the cloud metadata address.', true);
            }

            const record = await store.add(host, args.port);
            const portText = describePort(record.port);

            return textResult(`The browser may now reach ${record.host}, ${portText}. Id ${record.id}.`);
        },
    );
    const listTool = tool(
        LIST_TOOL_NAME,
        LIST_DESCRIPTION,
        LIST_SHAPE,
        async (): Promise<BrowserAllowToolResult> => {
            const records = await store.list();

            if (records.length === 0) {
                return textResult('No private hosts are allowed.');
            }

            const lines = records.map(describeRecord);

            const listText = lines.join('\n');

            return textResult(listText);
        },
    );
    const removeTool = tool(
        REMOVE_TOOL_NAME,
        REMOVE_DESCRIPTION,
        REMOVE_SHAPE,
        async (args): Promise<BrowserAllowToolResult> => {
            const removed = await store.remove(args.id);

            return removed
                ? textResult('The host was removed from the allow list.')
                : textResult('No allowed host has that id.', true);
        },
    );

    return [allowTool, listTool, removeTool] as CloudbotTool[];
}

function describeRecord(record: BrowserAllowRecord): string {
    return `- ${record.id}: ${record.host}, ${describePort(record.port)}`;
}

export { BROWSER_ALLOW_TOOL_FULL_NAMES, createBrowserAllowTools };
