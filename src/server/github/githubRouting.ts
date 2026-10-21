import type { IncomingHttpHeaders } from 'node:http';

import type { BotSecrets } from '../secrets/BotSecrets.ts';
import { hasHiddenCode } from '../text/isHiddenCode.ts';

// The owner saves the token under this name in the secure form, with the GitHub site.
const GITHUB_TOKEN_NAME = 'GITHUB_TOKEN';
const GITHUB_SITE = 'https://github.com';
const GITHUB_GIT_ORIGIN = 'https://github.com';
const GITHUB_API_ORIGIN = 'https://api.github.com';
// gh calls the REST API under /api/v3 and GraphQL under /api/graphql on the host it is given.
const REST_PREFIX = '/api/v3';
const GRAPHQL_PATH = '/api/graphql';
const LOOPBACK_HOST = '127.0.0.1';
// gh needs a token to start. The proxy drops it, so any value works.
const DUMMY_GITHUB_TOKEN = 'cloudbot-github-proxy';
const TITLE_MAX_LENGTH = 120;
// The owner must see everything that runs, so a change whose card would be longer is refused, never cut.
const CARD_MAX_CHARS = 6000;
const MAX_PUSH_COMMANDS = 100;
const NOT_FOUND_STATUS = 404;
const FORBIDDEN_STATUS = 403;
const ALLOWED_REST_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE_REST_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const GIT_PATH_PATTERN = /^\/(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+?)(?:\.git)?\/(?<service>info\/refs|git-upload-pack|git-receive-pack)$/;
const PULL_REQUEST_PATH = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/;
const REVIEW_PATH = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/;
const COMMENT_PATH = /^\/repos\/([^/]+)\/([^/]+)\/(?:issues|pulls)\/(\d+)\/comments$/;
const MUTATION_PATTERN = /\bmutation\b/i;
const PKT_HEADER_PATTERN = /^[0-9a-f]{4}$/;
const FLUSH_PACKET = '0000';
const PKT_HEADER_BYTES = 4;
const COMMAND_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/;
const ZERO_HASH_PATTERN = /^0+$/;
const SHORT_HASH_LENGTH = 7;
const DROPPED_REQUEST_HEADERS = new Set([
    'host',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'content-length',
    'accept-encoding',
    'authorization',
    'proxy-authorization',
    'cookie',
    'te',
    'upgrade',
    'expect',
    'x-http-method-override',
    'x-method-override',
    'x-http-method',
]);
const DROPPED_RESPONSE_HEADERS = new Set([
    'location',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'content-encoding',
    'content-length',
    'set-cookie',
]);

interface GithubPlan {
    method: string;
    upstream: URL;
    isGit: boolean;
    isWrite: boolean;
    // GitHub refuses a write or a push without a token. The proxy says so before it asks the owner.
    needsToken: boolean;
    // One line for the owner's card. Empty for reads.
    summary: string;
    // Shown under the summary. Undefined when there is nothing to show, such as a clone.
    detail: string | undefined;
}

interface GithubAllowedRequest {
    isAllowed: true;
    plan: GithubPlan;
}

// statusCode is what the client gets. A card that cannot show everything is refused with 403.
interface GithubRefusedRequest {
    isAllowed: false;
    statusCode: number;
    reason: string;
}

type GithubClassification = GithubAllowedRequest | GithubRefusedRequest;

interface GithubEnvironmentOptions {
    port: number;
    // The loopback certificate alone. git trusts it for the proxy address only.
    caFile: string;
    // The system roots plus the loopback certificate. Other tools in the shell, such as curl and pip, read it.
    bundleFile: string;
}

interface GitPushCommand {
    oldHash: string;
    newHash: string;
    refName: string;
}

type GitGroups = Record<string, string | undefined>;

function refuse(reason: string, statusCode: number = NOT_FOUND_STATUS): GithubRefusedRequest {
    return { isAllowed: false, statusCode, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        // A body that is not JSON has no fields to read, so the caller refuses it when it must show it.
        return undefined;
    }
}

function readStringField(record: Record<string, unknown>, fieldName: string): string | undefined {
    const value = record[fieldName];

    return typeof value === 'string' ? value : undefined;
}

function oneLine(text: string, maxLength: number): string {
    return text.replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

// A card that is too long or hides characters is refused. The owner always sees the whole change.
function refuseUnshowable(card: string): GithubRefusedRequest | undefined {
    if (card.length > CARD_MAX_CHARS) {
        return refuse(`This change is longer than ${String(CARD_MAX_CHARS)} characters, so the owner cannot read all of it. Split it into smaller changes.`, FORBIDDEN_STATUS);
    }

    if (hasHiddenCode(card)) {
        return refuse('This change has a control, bidi or zero-width character, which could hide what it does, so it was not sent.', FORBIDDEN_STATUS);
    }

    return undefined;
}

function readTitle(parsed: unknown): string | undefined {
    if (!isRecord(parsed)) {
        return undefined;
    }

    const title = readStringField(parsed, 'title');

    return title === undefined ? undefined : oneLine(title, TITLE_MAX_LENGTH);
}

function describeRestWrite(method: string, restPath: string, parsed: unknown): string {
    const pullMatch = PULL_REQUEST_PATH.exec(restPath);
    const reviewMatch = REVIEW_PATH.exec(restPath);
    const commentMatch = COMMENT_PATH.exec(restPath);

    if (method === 'POST' && pullMatch !== null) {
        const repoName = `${pullMatch[1] ?? ''}/${pullMatch[2] ?? ''}`;
        const title = readTitle(parsed);

        return title === undefined
            ? `Open a pull request in ${repoName}.`
            : `Open a pull request in ${repoName} titled "${title}".`;
    }

    if (method === 'POST' && reviewMatch !== null) {
        return `Post a review on pull request #${reviewMatch[3] ?? ''} in ${reviewMatch[1] ?? ''}/${reviewMatch[2] ?? ''}.`;
    }

    if (method === 'POST' && commentMatch !== null) {
        return `Post a comment on #${commentMatch[3] ?? ''} in ${commentMatch[1] ?? ''}/${commentMatch[2] ?? ''}.`;
    }

    return `Send a ${method} request to GitHub at ${restPath}.`;
}

function shortHash(hash: string): string {
    return hash.slice(0, SHORT_HASH_LENGTH);
}

// git cannot tell a force push from an ordinary update here, so every move is shown as an update with both hashes.
function describePushCommand(command: GitPushCommand): string {
    const isCreate = ZERO_HASH_PATTERN.test(command.oldHash);
    const isDelete = ZERO_HASH_PATTERN.test(command.newHash);

    if (isCreate) {
        return `create ${command.refName} at ${shortHash(command.newHash)}`;
    }

    if (isDelete) {
        return `delete ${command.refName}`;
    }

    return `update ${command.refName} from ${shortHash(command.oldHash)} to ${shortHash(command.newHash)}`;
}

function parseCommandLine(payload: string): GitPushCommand | undefined {
    // The first command line carries the capabilities after a NUL, and every line ends with a line feed.
    const beforeCapabilities = payload.split('\0');
    const commandText = (beforeCapabilities[0] ?? '').replace(/\n$/, '');
    const match = COMMAND_PATTERN.exec(commandText);

    if (match === null) {
        return undefined;
    }

    return { oldHash: match[1] ?? '', newHash: match[2] ?? '', refName: match[3] ?? '' };
}

// Reads the pkt-lines before the flush packet. Each one is a 4 hex digit length that counts itself, then the payload.
function readPktPayloads(body: Buffer, offset: number, payloads: string[]): string[] | undefined {
    if (payloads.length > MAX_PUSH_COMMANDS) {
        return undefined;
    }

    const header = body.subarray(offset, offset + PKT_HEADER_BYTES)
        .toString('ascii');

    if (header === FLUSH_PACKET) {
        return payloads;
    }

    if (!PKT_HEADER_PATTERN.test(header)) {
        return undefined;
    }

    const length = parseInt(header, 16);

    if (length < PKT_HEADER_BYTES || offset + length > body.length) {
        return undefined;
    }

    const payload = body.subarray(offset + PKT_HEADER_BYTES, offset + length)
        .toString('utf8');

    return readPktPayloads(body, offset + length, [...payloads, payload]);
}

// Returns the ref commands of a push, or undefined when the command section cannot be read.
function readPushCommands(body: Buffer): GitPushCommand[] | undefined {
    const payloads = readPktPayloads(body, 0, []);

    if (payloads === undefined || payloads.length === 0) {
        return undefined;
    }

    const commands = payloads.map(parseCommandLine);

    if (commands.some(command => command === undefined)) {
        return undefined;
    }

    return commands.filter((command): command is GitPushCommand => command !== undefined);
}

function classifyPush(owner: string, repo: string, target: URL, body: Buffer): GithubClassification {
    const commands = readPushCommands(body);

    if (commands === undefined) {
        return refuse('The ref commands of this push cannot be read, so it was not sent.', FORBIDDEN_STATUS);
    }

    const commandLines = commands.map(describePushCommand);
    const detail = `Refs to change:\n${commandLines.join('\n')}`;
    const refusal = refuseUnshowable(detail);

    if (refusal !== undefined) {
        return refusal;
    }

    const upstream = new URL(`${GITHUB_GIT_ORIGIN}${target.pathname}`);

    return {
        isAllowed: true,
        plan: {
            method: 'POST',
            upstream,
            isGit: true,
            isWrite: true,
            needsToken: true,
            summary: `Push commits to ${owner}/${repo} on GitHub.`,
            detail,
        },
    };
}

function classifyGit(method: string, target: URL, groups: GitGroups, body: Buffer): GithubClassification {
    const service = groups.service ?? '';
    const isAdvertisement = service === 'info/refs';
    const expectedMethod = isAdvertisement ? 'GET' : 'POST';

    if (method !== expectedMethod) {
        return refuse(`Git ${service} takes ${expectedMethod}.`);
    }

    const owner = groups.owner ?? '';
    const repo = groups.repo ?? '';

    if (service === 'git-receive-pack') {
        return classifyPush(owner, repo, target, body);
    }

    // git asks for the push advertisement first, and GitHub refuses it without a token.
    const isPushAdvertisement = isAdvertisement && target.searchParams.get('service') === 'git-receive-pack';
    const upstream = new URL(`${GITHUB_GIT_ORIGIN}${target.pathname}${target.search}`);

    return {
        isAllowed: true,
        plan: { method, upstream, isGit: true, isWrite: false, needsToken: isPushAdvertisement, summary: '', detail: undefined },
    };
}

function classifyRest(method: string, target: URL, body: Buffer): GithubClassification {
    if (!ALLOWED_REST_METHODS.has(method)) {
        return refuse(`The GitHub API does not take ${method} here.`);
    }

    const restPath = target.pathname.slice(REST_PREFIX.length);
    const upstream = new URL(`${GITHUB_API_ORIGIN}${restPath}${target.search}`);
    const isWrite = WRITE_REST_METHODS.has(method);

    if (!isWrite) {
        return { isAllowed: true, plan: { method, upstream, isGit: false, isWrite, needsToken: false, summary: '', detail: undefined } };
    }

    const bodyText = body.toString('utf8');
    const parsed = parseJson(bodyText);
    const summary = describeRestWrite(method, restPath, parsed);
    // The method, path and query come first, so a PATCH on the repository is visible in the card.
    // GitHub can read fields from the query of a write too, so the query is checked like the body.
    const requestLine = `${method} ${restPath}${target.search}`;
    const detail = bodyText.length === 0 ? requestLine : `${requestLine}\n\n${bodyText}`;
    const refusal = refuseUnshowable(detail);

    if (refusal !== undefined) {
        return refusal;
    }

    return { isAllowed: true, plan: { method, upstream, isGit: false, isWrite, needsToken: true, summary, detail } };
}

function classifyGraphql(method: string, body: Buffer): GithubClassification {
    if (method !== 'POST') {
        return refuse('The GitHub GraphQL API takes POST.');
    }

    const bodyText = body.toString('utf8');
    const parsed = parseJson(bodyText);
    const query = isRecord(parsed) ? readStringField(parsed, 'query') : undefined;

    // A body that cannot be read cannot be shown to the owner, so it is refused, whether or not it is a change.
    if (!isRecord(parsed) || query === undefined) {
        return refuse('The GraphQL request cannot be read, so it was not sent.', FORBIDDEN_STATUS);
    }

    const upstream = new URL(`${GITHUB_API_ORIGIN}/graphql`);
    const isWrite = MUTATION_PATTERN.test(query);

    if (!isWrite) {
        return { isAllowed: true, plan: { method, upstream, isGit: false, isWrite, needsToken: false, summary: '', detail: undefined } };
    }

    // The card shows the whole query and every other field of the request, pretty printed.
    const fieldEntries = Object.entries(parsed)
        .filter(([key]) => key !== 'query');
    const otherFields = Object.fromEntries(fieldEntries);
    const detail = `${query}\n\n${JSON.stringify(otherFields, null, 2)}`;
    const refusal = refuseUnshowable(detail);

    if (refusal !== undefined) {
        return refusal;
    }

    return {
        isAllowed: true,
        plan: { method, upstream, isGit: false, isWrite, needsToken: true, summary: 'Run a change on GitHub (GraphQL).', detail },
    };
}

// Only GitHub's git smart HTTP paths, the REST API and GraphQL get through. Any other address is refused.
// The host of the upstream comes from these constants only, so a request path cannot pick another host.
function classifyGithubRequest(method: string, requestTarget: string, body: Buffer): GithubClassification {
    let target: URL;

    try {
        target = new URL(requestTarget, `https://${LOOPBACK_HOST}`);
    } catch {
        return refuse('The address of this request is not valid.');
    }

    const gitMatch = GIT_PATH_PATTERN.exec(target.pathname);

    if (gitMatch?.groups !== undefined) {
        return classifyGit(method, target, gitMatch.groups, body);
    }

    if (target.pathname === GRAPHQL_PATH) {
        return classifyGraphql(method, body);
    }

    if (target.pathname.startsWith(`${REST_PREFIX}/`)) {
        return classifyRest(method, target, body);
    }

    return refuse('Only GitHub git and API addresses can be reached through the proxy.');
}

// Git gets Basic auth with the token, as GitHub expects for smart HTTP. The API gets a Bearer token.
function buildAuthorization(token: string | undefined, isGit: boolean): string | undefined {
    if (token === undefined) {
        return undefined;
    }

    if (!isGit) {
        return `Bearer ${token}`;
    }

    const credentials = Buffer.from(`x-access-token:${token}`)
        .toString('base64');

    return `Basic ${credentials}`;
}

// The agent's own credentials are dropped. The token is the only one GitHub sees.
function buildUpstreamHeaders(incomingHeaders: IncomingHttpHeaders, token: string | undefined, isGit: boolean): Record<string, string> {
    const forwardedHeaders: Record<string, string> = {};

    Object.entries(incomingHeaders)
        .forEach(([headerName, headerValue]) => {
            if (headerValue === undefined || DROPPED_REQUEST_HEADERS.has(headerName)) {
                return;
            }

            forwardedHeaders[headerName] = Array.isArray(headerValue) ? headerValue.join(', ') : headerValue;
        });

    const authorization = buildAuthorization(token, isGit);

    if (authorization !== undefined) {
        forwardedHeaders['authorization'] = authorization;
    }

    return forwardedHeaders;
}

function buildResponseHeaders(upstreamHeaders: Headers): Record<string, string> {
    const responseHeaders: Record<string, string> = {};

    upstreamHeaders.forEach((headerValue, headerName) => {
        if (!DROPPED_RESPONSE_HEADERS.has(headerName)) {
            responseHeaders[headerName] = headerValue;
        }
    });

    return responseHeaders;
}

// The values gh and git read. Only the port and the certificate files differ between bots.
// gh reaches the proxy through GH_HOST, which needs https, so the bundle is trusted through SSL_CERT_FILE.
// git's insteadOf sends github.com addresses to the proxy, and sslCAInfo trusts the loopback certificate for the proxy address only.
function buildGithubEnvironment(options: GithubEnvironmentOptions): Record<string, string> {
    const portText = String(options.port);
    const proxyOrigin = `https://${LOOPBACK_HOST}:${portText}`;

    return {
        GH_HOST: `${LOOPBACK_HOST}:${portText}`,
        GH_ENTERPRISE_TOKEN: DUMMY_GITHUB_TOKEN,
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        SSL_CERT_FILE: options.bundleFile,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: `url.${proxyOrigin}/.insteadOf`,
        GIT_CONFIG_VALUE_0: `${GITHUB_GIT_ORIGIN}/`,
        // An empty helper resets the helpers, so git never asks for a credential on its own.
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: '',
        GIT_CONFIG_KEY_2: `http.${proxyOrigin}/.sslCAInfo`,
        GIT_CONFIG_VALUE_2: options.caFile,
    };
}

// The token is sent only to its own site. A secret saved for another site throws, so it is never used.
function readGithubToken(secrets: Pick<BotSecrets, 'read'>, botId: string): string | undefined {
    const secret = secrets.read(botId, GITHUB_TOKEN_NAME);

    if (secret === undefined) {
        return undefined;
    }

    if (secret.site !== GITHUB_SITE) {
        throw new Error('The GitHub token is saved for another site.');
    }

    return secret.value;
}

export {
    DUMMY_GITHUB_TOKEN,
    GITHUB_SITE,
    GITHUB_TOKEN_NAME,
    LOOPBACK_HOST,
    buildGithubEnvironment,
    buildResponseHeaders,
    buildUpstreamHeaders,
    classifyGithubRequest,
    readGithubToken,
    readPushCommands,
};
export type { GithubAllowedRequest, GithubClassification, GithubEnvironmentOptions, GithubPlan, GithubRefusedRequest };
