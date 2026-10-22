import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod/v4';

import type { ToolCall, ToolCallDecision } from './AgentRunner.ts';

// One tool of the bot's MCP server, served to the CLI.
interface LoopbackTool {
    name: string;
    description: string;
    inputSchema: Readonly<Record<string, z.core.$ZodType>>;
    handler(args: Record<string, unknown>, extra: unknown): Promise<LoopbackToolResult>;
}

interface LoopbackToolResult {
    content: unknown[];
    isError?: boolean | undefined;
}

interface LoopbackTurnGrant {
    tools: LoopbackTool[];
    reviewToolCall: (call: ToolCall, signal: AbortSignal) => Promise<ToolCallDecision>;
    // Other MCP servers of the owner's config. They are written into the same mcp.json.
    remoteServers?: Record<string, unknown> | undefined;
    // Tools the owner blocked. The CLI already hides them, and the decision route refuses them too (exact name match).
    disallowedTools?: string[] | undefined;
    // False for an engine that decides calls itself, such as Codex. The permission prompt tool is then not listed.
    offersPromptTool?: boolean | undefined;
    // True for an engine whose agent sends no call id with tools/call, such as an ACP agent. Each call then goes to
    // reviewToolCall here before it runs.
    reviewsEachCall?: boolean | undefined;
}

// The files the CLI reads for one turn. They live in a folder of their own, removed on release.
interface LoopbackTurn {
    folder: string;
    mcpConfigPath: string;
    settingsPath: string;
    // Called for each tool_use block the CLI writes to its own stdout. Only a noted call can be decided or run.
    noteToolUse(toolUseId: string, toolName: string, input: unknown): void;
    // Writes a file into the turn folder with the turn's file mode, and returns its path.
    writeFile(name: string, text: string): string;
    // For an engine that reviews a call itself, such as Codex: the one tools/call with this id, name and input may run once.
    allowCall(toolUseId: string, toolName: string, input: unknown): void;
    // The address and the token of the turn, for an engine that does not read the MCP config file.
    mcpUrl: string;
    token: string;
    release(): void;
}

interface LoopbackToolServer {
    grantTurn(grant: LoopbackTurnGrant): LoopbackTurn;
    close(): Promise<void>;
}

interface LoopbackServerOptions {
    // Folder that holds the turn folders. Unset uses the system temp folder.
    turnRoot?: string | undefined;
    // Set when a second user runs the CLI. The turn root is then created with mode 2710, and each turn folder with 2750.
    // Files get 0640. The root must be owned by the server user with the group of that second user.
    agentReadable?: boolean | undefined;
}

// What the CLI reported for one tool use, and what became of it. Each tool use gets one decision and one run at most.
interface CallState {
    toolName: string;
    inputKey: string;
    decided: boolean;
    allowed: boolean;
    consumed: boolean;
}

interface TurnState {
    grant: LoopbackTurnGrant;
    calls: Map<string, CallState>;
    // The calls the owner denied in this turn, by tool and input. The same call again is refused without a second card.
    refusedCalls: Set<string>;
    folder: string;
    fileMode: number;
    isReleased: boolean;
    controller: AbortController;
}

// Built-in tools the CLI may offer. --tools takes this list, and every entry is also an ask rule, so each call is decided.
const BUILTIN_TOOLS = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Task', 'WebFetch', 'WebSearch', 'Write'];
// The CLI calls the Task tool Agent in its prompt call, so the alias is asked as well and matched to Task.
const TOOL_NAME_ALIASES: Record<string, string> = { Agent: 'Task' };
// Built-in tools whose description argument is only a label for the person.
const LABELLED_TOOLS = ['Bash', 'Task'];
// The permission prompt tool. The CLI calls it for each ask-rule call. The model never sees it (--disallowedTools).
const APPROVE_TOOL_NAME = 'approve';
const AGENT_TURN_ROOT = '/var/lib/cloudbot-turns';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const SEEN_WAIT_MS = 2000;
const SEEN_POLL_MS = 10;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TURN_FOLDER_MODE = 0o2750;
const TURN_ROOT_MODE = 0o2710;
const PRIVATE_FOLDER_MODE = 0o700;
const AGENT_FILE_MODE = 0o640;
const PRIVATE_FILE_MODE = 0o600;
const TURN_ENDED_REASON = 'This turn is no longer running, so the action was not run.';
const UNSEEN_CALL_REASON = 'The CLI did not report this call, so it was not run.';
const BLOCKED_REASON = 'The owner blocked this tool.';
const REVIEW_FAILED_REASON = 'This action could not be reviewed, so it was not run.';
const REPEATED_DECISION_REASON = 'This call was already decided, so it was not run again.';
const APPROVE_AS_TOOL_REASON = 'The permission tool is not a tool for the model.';
const NOT_APPROVED_TEXT = 'The owner has not approved this call, so it was not run.';
const REPEATED_REFUSAL_REASON = 'The owner already denied this same action in this turn, so it was not asked again. Do not try it again. Tell the owner what you wanted to do and why.';

const stringSchema = z.string();
const numberSchema = z.number();
const nullSchema = z.null();
const unknownSchema = z.unknown();
const requestIdSchema = z.union([stringSchema, numberSchema, nullSchema]);
const jsonObjectSchema = z.record(stringSchema, unknownSchema);

const jsonRpcRequestSchema = z.object({
    id: requestIdSchema.optional(),
    method: stringSchema,
    params: jsonObjectSchema.optional(),
});

// The prompt call: the CLI sends the tool it wants to run, its input and the tool use id.
const approveArgumentsSchema = z.object({
    tool_name: stringSchema,
    input: unknownSchema.optional(),
    tool_use_id: stringSchema.optional(),
});

// The CLI sends the tool use id of the call in the request's _meta. Codex sends it as callId (seen with codex-cli 0.163.0).
const toolCallMetaSchema = z.object({ 'claudecode/toolUseId': stringSchema.optional(), 'callId': stringSchema.optional() });

class BodyTooLargeError extends Error {}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        request.on('data', (chunk: Buffer) => {
            size += chunk.length;

            if (size > MAX_BODY_BYTES) {
                request.destroy();
                reject(new BodyTooLargeError('The request body is too large.'));

                return;
            }

            chunks.push(chunk);
        });
        request.on('end', () => {
            const joined = Buffer.concat(chunks);
            const text = joined.toString('utf8');

            resolve(text);
        });
        request.on('error', reject);
    });
}

// A body that is not JSON becomes undefined, which the schemas refuse.
function parseJson(body: string): unknown {
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
}

// Sorted keys, so the same input always gives the same key, whatever order the CLI writes it in.
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        const items = value.map(item => canonicalJson(item));

        return `[${items.join(',')}]`;
    }

    if (value !== null && typeof value === 'object') {
        const record: Record<string, unknown> = { ...value };
        const keyNames = Object.keys(record);
        const keys = keyNames.sort();
        const members = keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);

        return `{${members.join(',')}}`;
    }

    const encoded = JSON.stringify(value);

    return encoded;
}

function inputKeyOf(input: unknown): string {
    const normalized = input ?? {};

    return canonicalJson(normalized);
}

// The description of a Bash or Task call only labels it for the person, so a retry with new words is still the same call.
// An MCP tool may have a real description argument, such as the bot's profile, so its input is kept whole.
function refusalKeyOf(toolName: string, input: unknown): string {
    const isLabelled = LABELLED_TOOLS.includes(toolName) && input !== null && typeof input === 'object' && !Array.isArray(input);

    if (!isLabelled) {
        return `${toolName}\n${inputKeyOf(input)}`;
    }

    const entries = Object.entries(input)
        .filter(([key]) => key !== 'description');
    const unlabelled = Object.fromEntries(entries);

    return `${toolName}\n${inputKeyOf(unlabelled)}`;
}

function normalizeToolName(name: string): string {
    return TOOL_NAME_ALIASES[name] ?? name;
}

function isApproveTool(name: string): boolean {
    return name === APPROVE_TOOL_NAME || name.endsWith(`__${APPROVE_TOOL_NAME}`);
}

function refuse(reason: string): ToolCallDecision {
    return { isAllowed: false, reason };
}

// A review that throws is a refusal, so a broken review never lets a call run.
async function decideCall(
    reviewToolCall: (call: ToolCall, signal: AbortSignal) => Promise<ToolCallDecision>,
    call: ToolCall,
    signal: AbortSignal,
): Promise<ToolCallDecision> {
    try {
        return await reviewToolCall(call, signal);
    } catch {
        return refuse(REVIEW_FAILED_REASON);
    }
}

// Reads the flag at call time. A check after an await is not narrowed to the value read before it.
function isReleasedNow(turn: TurnState): boolean {
    return turn.isReleased;
}

// The CLI writes a tool_use line before it asks, but the line and the request can arrive in either order.
// So a call that is not noted yet gets a short wait. A stolen token cannot make a line appear on the CLI's stdout.
function waitForSeenCall(turn: TurnState, toolUseId: string, deadline: number): Promise<CallState | undefined> {
    const seen = turn.calls.get(toolUseId);

    if (seen !== undefined || Date.now() >= deadline) {
        return Promise.resolve(seen);
    }

    return new Promise<void>((resolve) => {
        setTimeout(resolve, SEEN_POLL_MS);
    })
        .then(() => waitForSeenCall(turn, toolUseId, deadline));
}

// The permission prompt answer. One decision per tool use: a repeated or concurrent prompt for the same id is refused.
async function decidePrompt(turn: TurnState, args: { tool_name: string; input: unknown; tool_use_id: string | undefined }): Promise<ToolCallDecision> {
    const toolName = normalizeToolName(args.tool_name);

    if (isApproveTool(args.tool_name)) {
        return refuse(APPROVE_AS_TOOL_REASON);
    }

    if (isReleasedNow(turn)) {
        return refuse(TURN_ENDED_REASON);
    }

    if (args.tool_use_id === undefined) {
        return refuse(UNSEEN_CALL_REASON);
    }

    const call = await waitForSeenCall(turn, args.tool_use_id, Date.now() + SEEN_WAIT_MS);

    // The decided flag is read and set with no await between, so two prompts for one id cannot both pass.
    if (call === undefined || call.toolName !== toolName || call.inputKey !== inputKeyOf(args.input)) {
        return refuse(UNSEEN_CALL_REASON);
    }

    if (call.decided) {
        return refuse(REPEATED_DECISION_REASON);
    }

    call.decided = true;

    if (turn.grant.disallowedTools?.includes(toolName) === true) {
        return refuse(BLOCKED_REASON);
    }

    const refusalKey = refusalKeyOf(toolName, args.input);

    // A model may repeat a call the owner just denied. A second card for it would only ask the owner again.
    if (turn.refusedCalls.has(refusalKey)) {
        return refuse(REPEATED_REFUSAL_REASON);
    }

    const decision = await decideCall(turn.grant.reviewToolCall, { toolName, input: args.input }, turn.controller.signal);

    if (isReleasedNow(turn)) {
        return refuse(TURN_ENDED_REASON);
    }

    // Only the owner's Deny is kept. Other refusals may depend on a state that changes, such as a file the bot fixes next.
    if (!decision.isAllowed && decision.isOwnerDenial === true) {
        turn.refusedCalls.add(refusalKey);
    }

    call.allowed = decision.isAllowed;

    return decision;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body === undefined ? '' : JSON.stringify(body));
}

function toolInputSchema(tool: LoopbackTool): Record<string, unknown> {
    const objectSchema = z.object(tool.inputSchema);

    return z.toJSONSchema(objectSchema);
}

function failedResult(text: string): LoopbackToolResult {
    return { isError: true, content: [{ type: 'text', text }] };
}

function textResult(text: string): LoopbackToolResult {
    return { isError: false, content: [{ type: 'text', text }] };
}

function decisionResult(decision: unknown): LoopbackToolResult {
    const text = JSON.stringify(decision);

    return textResult(text);
}

function callTool(tool: LoopbackTool, args: unknown): Promise<LoopbackToolResult> {
    const objectSchema = z.object(tool.inputSchema);
    const givenArguments = args ?? {};
    const parsed = objectSchema.safeParse(givenArguments);

    if (!parsed.success) {
        const refusal = failedResult('The arguments do not match the tool.');

        return Promise.resolve(refusal);
    }

    return tool.handler(parsed.data, {})
        .catch(() => failedResult('The tool failed.'));
}

// A tools/call runs once, and only with the allowed decision for this exact tool use. The check and the consume are one step.
// The review of a call that came with no call id. Returns the refusal reason, or undefined when the call may run.
async function reviewOwnCall(turn: TurnState, fullToolName: string, args: unknown): Promise<string | undefined> {
    if (turn.grant.disallowedTools?.includes(fullToolName) === true) {
        return NOT_APPROVED_TEXT;
    }

    try {
        const decision = await turn.grant.reviewToolCall({ toolName: fullToolName, input: args ?? {} }, turn.controller.signal);

        return decision.isAllowed ? undefined : decision.reason;
    } catch {
        return REVIEW_FAILED_REASON;
    }
}

function consumeAllowedCall(turn: TurnState, fullToolName: string, args: unknown, toolUseId: string | undefined): boolean {
    if (toolUseId === undefined) {
        return false;
    }

    const call = turn.calls.get(toolUseId);

    if (call === undefined || !call.allowed || call.consumed) {
        return false;
    }

    if (call.toolName !== fullToolName || call.inputKey !== inputKeyOf(args)) {
        return false;
    }

    call.consumed = true;

    return true;
}

async function answerPrompt(turn: TurnState, args: unknown): Promise<LoopbackToolResult> {
    const parsed = approveArgumentsSchema.safeParse(args);

    // Any failure of the prompt is a deny, so the CLI never runs the call.
    if (!parsed.success) {
        return decisionResult({ behavior: 'deny', message: REVIEW_FAILED_REASON });
    }

    const input = parsed.data.input ?? {};
    const decision = await decidePrompt(turn, { tool_name: parsed.data.tool_name, input, tool_use_id: parsed.data.tool_use_id });

    if (!decision.isAllowed) {
        return decisionResult({ behavior: 'deny', message: decision.reason });
    }

    return decisionResult({ behavior: 'allow', updatedInput: input });
}

async function answerMcp(serverName: string, turn: TurnState, body: string, response: ServerResponse): Promise<void> {
    const parsedJson = parseJson(body);
    const parsedBody = jsonRpcRequestSchema.safeParse(parsedJson);

    if (!parsedBody.success) {
        writeJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request.' } });

        return;
    }

    const request = parsedBody.data;

    // A notification has no id, and gets no JSON-RPC answer.
    if (request.id === undefined) {
        response.writeHead(202);
        response.end();

        return;
    }

    const id = request.id;
    const params = request.params ?? {};

    if (request.method === 'initialize') {
        writeJson(response, 200, {
            jsonrpc: '2.0',
            id,
            result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: serverName, version: '1.0.0' } },
        });

        return;
    }

    if (request.method === 'ping') {
        writeJson(response, 200, { jsonrpc: '2.0', id, result: {} });

        return;
    }

    if (request.method === 'tools/list') {
        const tools = turn.grant.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: toolInputSchema(tool) }));
        const approveTool = {
            name: APPROVE_TOOL_NAME,
            description: 'Permission prompt for the CLI. Not a tool for the model.',
            inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } } },
        };

        const listed = turn.grant.offersPromptTool === false ? tools : [...tools, approveTool];

        writeJson(response, 200, { jsonrpc: '2.0', id, result: { tools: listed } });

        return;
    }

    if (request.method === 'tools/call') {
        if (params.name === APPROVE_TOOL_NAME) {
            const result = await answerPrompt(turn, params.arguments);

            writeJson(response, 200, { jsonrpc: '2.0', id, result });

            return;
        }

        const tool = turn.grant.tools.find(candidate => candidate.name === params.name);

        if (tool === undefined) {
            writeJson(response, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool.' } });

            return;
        }

        const fullToolName = `mcp__${serverName}__${tool.name}`;
        const parsedMeta = toolCallMetaSchema.safeParse(params._meta);
        const metaToolUseId = parsedMeta.success ? parsedMeta.data['claudecode/toolUseId'] ?? parsedMeta.data.callId : undefined;

        if (!consumeAllowedCall(turn, fullToolName, params.arguments, metaToolUseId)) {
            const refusal = turn.grant.reviewsEachCall === true ? await reviewOwnCall(turn, fullToolName, params.arguments) : NOT_APPROVED_TEXT;

            if (refusal !== undefined) {
                writeJson(response, 200, { jsonrpc: '2.0', id, result: failedResult(refusal) });

                return;
            }

            // A client that gave up during a long review already saw a failure and may ask again, so the call does not run.
            if (response.socket?.destroyed !== false) {
                return;
            }
        }

        // The turn may have been released while the body was read. The handler never runs then.
        if (isReleasedNow(turn)) {
            writeJson(response, 200, { jsonrpc: '2.0', id, result: failedResult(TURN_ENDED_REASON) });

            return;
        }

        const result = await callTool(tool, params.arguments);

        writeJson(response, 200, { jsonrpc: '2.0', id, result });

        return;
    }

    writeJson(response, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } });
}

function dropTurn(turn: TurnState, turns: Map<string, TurnState>, token: string): void {
    if (turn.isReleased) {
        return;
    }

    turn.isReleased = true;
    turn.controller.abort();
    turns.delete(token);
    rmSync(turn.folder, { recursive: true, force: true });
}

async function startLoopbackToolServer(serverName: string, options: LoopbackServerOptions = {}): Promise<LoopbackToolServer> {
    const turnRoot = options.turnRoot ?? tmpdir();
    const folderMode = options.agentReadable ? TURN_FOLDER_MODE : PRIVATE_FOLDER_MODE;
    const fileMode = options.agentReadable ? AGENT_FILE_MODE : PRIVATE_FILE_MODE;
    const turns = new Map<string, TurnState>();
    // Set once the server listens. A request whose Host is another name is a page in the owner's browser, so it is refused.
    let expectedHost = '';

    if (options.agentReadable) {
        // chmod, not only mkdir mode: the umask and an existing folder would otherwise change the mode.
        mkdirSync(turnRoot, { recursive: true, mode: TURN_ROOT_MODE });
        chmodSync(turnRoot, TURN_ROOT_MODE);
    }

    const server = createServer((request, response) => {
        // Only the path is matched, as a string. Parsing the raw target with URL throws on paths such as //, which would kill the server.
        const [path = ''] = (request.url ?? '/').split('?');

        if (path !== '/mcp') {
            writeJson(response, 404, { error: 'Not found.' });

            return;
        }

        // A request with an Origin header comes from a page in a browser. The CLI sends none.
        const isForeign = request.headers.host !== expectedHost || request.headers.origin !== undefined;

        if (isForeign) {
            request.resume();
            writeJson(response, 403, { error: 'The request is not allowed.' });

            return;
        }

        if (request.method !== 'POST') {
            writeJson(response, 405, { error: 'Method not allowed.' });

            return;
        }

        const authorization = request.headers.authorization ?? '';
        const token = authorization.replace(/^Bearer /, '');

        readBody(request)
            .then(async (body) => {
                // The turn is looked up after the body is read, so a turn released during the upload is refused.
                const turn = turns.get(token);

                if (turn === undefined || turn.isReleased) {
                    writeJson(response, 200, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'The turn is not known.' } });

                    return;
                }

                await answerMcp(serverName, turn, body, response);
            })
            .catch((error: unknown) => {
                if (error instanceof BodyTooLargeError) {
                    writeJson(response, 413, { error: 'The request body is too large.' });

                    return;
                }

                writeJson(response, 500, { error: 'The request could not be read.' });
            });
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();

    if (address === null || typeof address === 'string') {
        throw new Error('The loopback tool server has no address.');
    }

    expectedHost = `127.0.0.1:${String(address.port)}`;
    const baseUrl = `http://${expectedHost}`;

    return {
        grantTurn(grant: LoopbackTurnGrant): LoopbackTurn {
            const token = randomBytes(32)
                .toString('hex');
            const folderPrefix = join(turnRoot, 'cloudbot-turn-');
            const folder = mkdtempSync(folderPrefix);
            const mcpConfigPath = join(folder, 'mcp.json');
            const settingsPath = join(folder, 'settings.json');
            const state: TurnState = { grant, calls: new Map(), refusedCalls: new Set(), folder, fileMode, isReleased: false, controller: new AbortController() };
            const headers = { Authorization: `Bearer ${token}` };
            const loopbackServer = { [serverName]: { type: 'http', url: `${baseUrl}/mcp`, headers } };
            const remoteNames = Object.keys(grant.remoteServers ?? {});
            const mcpConfig = { mcpServers: { ...grant.remoteServers, ...loopbackServer } };
            // Every built-in and every MCP server is an ask rule, so the prompt tool decides each call.
            const askRules = [...BUILTIN_TOOLS, ...Object.keys(TOOL_NAME_ALIASES), `mcp__${serverName}`, ...remoteNames.map(name => `mcp__${name}`)];
            const settings = { permissions: { ask: askRules } };

            chmodSync(folder, folderMode);
            const mcpText = JSON.stringify(mcpConfig);
            const settingsText = JSON.stringify(settings);

            writeFileSync(mcpConfigPath, mcpText, { mode: fileMode });
            writeFileSync(settingsPath, settingsText, { mode: fileMode });
            chmodSync(mcpConfigPath, fileMode);
            chmodSync(settingsPath, fileMode);
            turns.set(token, state);

            return {
                folder,
                mcpConfigPath,
                settingsPath,
                noteToolUse(toolUseId: string, toolName: string, input: unknown): void {
                    // The first report of an id is the one that counts. A repeat cannot change the name or the input.
                    if (!state.calls.has(toolUseId)) {
                        state.calls.set(toolUseId, { toolName: normalizeToolName(toolName), inputKey: inputKeyOf(input), decided: false, allowed: false, consumed: false });
                    }
                },
                writeFile(name: string, text: string): string {
                    const path = join(folder, name);

                    writeFileSync(path, text, { mode: fileMode });
                    chmodSync(path, fileMode);

                    return path;
                },
                allowCall(toolUseId: string, toolName: string, input: unknown): void {
                    // An id that is known already keeps its first state, so a second allow cannot reopen a used call.
                    if (!state.calls.has(toolUseId)) {
                        state.calls.set(toolUseId, { toolName, inputKey: inputKeyOf(input), decided: true, allowed: true, consumed: false });
                    }
                },
                mcpUrl: `${baseUrl}/mcp`,
                token,
                release(): void {
                    dropTurn(state, turns, token);
                },
            };
        },
        close(): Promise<void> {
            turns.forEach((state, token) => {
                dropTurn(state, turns, token);
            });

            return new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);

                        return;
                    }

                    resolve();
                });
                server.closeAllConnections();
            });
        },
    };
}

export { AGENT_TURN_ROOT, APPROVE_TOOL_NAME, BUILTIN_TOOLS, inputKeyOf, startLoopbackToolServer };
export type { LoopbackServerOptions, LoopbackTool, LoopbackToolResult, LoopbackToolServer, LoopbackTurn, LoopbackTurnGrant };
