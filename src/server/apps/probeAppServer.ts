import { Readable } from 'node:stream';

import { readCapped } from './readCapped.ts';

// Asks a remote MCP server for its tools, over the Streamable HTTP transport, with plain JSON-RPC requests.
// The token, when there is one, is sent to the server only. It is never put in a result or a message.

interface ConnectedProbe {
    status: 'connected';
    toolCount: number;
}

interface NeedsTokenProbe {
    status: 'needs_token';
}

interface FailedProbe {
    status: 'failed';
    problem: string;
}

type ProbeResult = ConnectedProbe | NeedsTokenProbe | FailedProbe;

type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

// The reply of one request, read from a JSON body or from a server-sent event stream.
interface RpcReply {
    status: number;
    sessionId: string | undefined;
    messages: RpcMessage[];
}

interface RpcMessage {
    id: unknown;
    result: unknown;
}

const PROTOCOL_VERSION = '2025-06-18';
const PROBE_TIMEOUT_MS = 15 * 1000;
// A reply larger than this is refused, so a server cannot make the probe hold a large body in memory.
const MAX_REPLY_BYTES = 1024 * 1024;
const MCP_ACCEPT = 'application/json, text/event-stream';
const UNAUTHORIZED_STATUSES = [401, 403];
const INITIALIZE_ID = 1;
const LIST_TOOLS_ID = 2;
const SSE_DATA_PREFIX = 'data:';
const NOT_MCP_PROBLEM = 'The server did not answer like an MCP server.';

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

function readMessage(value: unknown): RpcMessage | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }

    return { id: Reflect.get(value, 'id'), result: Reflect.get(value, 'result') };
}

function readStreamPayloads(text: string): unknown[] {
    const dataLines = text.split('\n')
        .filter(line => line.startsWith(SSE_DATA_PREFIX));
    const payloadTexts = dataLines.map(line => line.slice(SSE_DATA_PREFIX.length)
        .trim());

    return payloadTexts.map(parseJson);
}

// A stream holds one `data:` line per message. A JSON body holds one message, or a batch.
function readMessages(contentType: string, text: string): RpcMessage[] {
    const isStream = contentType.includes('text/event-stream');
    const payloads = isStream ? readStreamPayloads(text) : [parseJson(text)];

    return payloads.flatMap((payload) => {
        const items = Array.isArray(payload) ? payload : [payload];

        return items.map(readMessage)
            .filter((message): message is RpcMessage => message !== undefined);
    });
}

async function readReplyText(response: Response): Promise<string> {
    if (response.body === null) {
        return '';
    }

    const replyStream = Readable.fromWeb(response.body);
    const bytes = await readCapped(replyStream, MAX_REPLY_BYTES);

    return bytes.toString('utf8');
}

async function postMessage(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    fetchFunction: FetchFunction,
): Promise<RpcReply> {
    const response = await fetchFunction(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'accept': MCP_ACCEPT },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await readReplyText(response);
    const contentType = response.headers.get('content-type') ?? '';
    const sessionId = response.headers.get('mcp-session-id') ?? undefined;

    return { status: response.status, sessionId, messages: response.ok ? readMessages(contentType, text) : [] };
}

function findReply(reply: RpcReply, id: number): unknown {
    const message = reply.messages.find(candidate => candidate.id === id);

    return message?.result;
}

function countTools(result: unknown): number | undefined {
    if (typeof result !== 'object' || result === null) {
        return undefined;
    }

    const tools: unknown = Reflect.get(result, 'tools');

    return Array.isArray(tools) ? tools.length : undefined;
}

async function probeAppServer(url: string, token: string | undefined, fetchFunction: FetchFunction): Promise<ProbeResult> {
    const authHeaders: Record<string, string> = token === undefined ? {} : { authorization: `Bearer ${token}` };

    try {
        const initialize = await postMessage(url, {
            jsonrpc: '2.0',
            id: INITIALIZE_ID,
            method: 'initialize',
            params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'cloudbot', version: '1.0.0' } },
        }, authHeaders, fetchFunction);

        if (UNAUTHORIZED_STATUSES.includes(initialize.status)) {
            return token === undefined ? { status: 'needs_token' } : { status: 'failed', problem: 'The server refused the token.' };
        }

        if (initialize.status < 200 || initialize.status >= 300) {
            return { status: 'failed', problem: `The server answered with status ${String(initialize.status)}.` };
        }

        const initialized = findReply(initialize, INITIALIZE_ID);

        if (initialized === undefined) {
            return { status: 'failed', problem: NOT_MCP_PROBLEM };
        }

        const sessionHeaders = initialize.sessionId === undefined
            ? authHeaders
            : { ...authHeaders, 'mcp-session-id': initialize.sessionId };

        await postMessage(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionHeaders, fetchFunction);

        const listed = await postMessage(url, { jsonrpc: '2.0', id: LIST_TOOLS_ID, method: 'tools/list', params: {} }, sessionHeaders, fetchFunction);
        const listedTools = findReply(listed, LIST_TOOLS_ID);
        const toolCount = countTools(listedTools);

        if (toolCount === undefined) {
            return { status: 'failed', problem: NOT_MCP_PROBLEM };
        }

        return { status: 'connected', toolCount };
    } catch {
        return { status: 'failed', problem: 'The server could not be reached.' };
    }
}

export { probeAppServer };
export type { FetchFunction, ProbeResult };
