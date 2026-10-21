import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, pipeline } from 'node:stream';

import { BodyTooLargeError, readCapped } from '../apps/readCapped.ts';
import { LOOPBACK_HOST, buildGithubEnvironment, buildResponseHeaders, buildUpstreamHeaders, classifyGithubRequest } from './githubRouting.ts';

type GithubFetch = (url: URL, init: RequestInit) => Promise<Response>;

// The proxy holds the token and the approval. The bot reaches GitHub only through it.
interface GithubProxyOptions {
    // The bot's saved token, or undefined when none is saved. Throws when the saved token is for another site.
    readToken: (botId: string) => string | undefined;
    // Asks the owner about a write. Resolves true only when the owner approves.
    approve: (botId: string, summary: string, detail: string | undefined) => Promise<boolean>;
    key: string;
    cert: string;
    caFile: string;
    bundleFile: string;
    fetchFunction?: GithubFetch;
}

interface ProxyErrorResponse {
    error: string;
}

const BAD_GATEWAY_STATUS = 502;
const FORBIDDEN_STATUS = 403;
const TOO_MANY_REQUESTS_STATUS = 429;
const UNAUTHORIZED_STATUS = 401;
// One card at a time per bot, so a loop of writes cannot flood the owner.
const PENDING_APPROVAL_MESSAGE = 'Another GitHub change is waiting for the owner.';
const NO_TOKEN_MESSAGE = 'No GitHub token is saved for this bot, so the request was not sent. Ask the owner to save one as GITHUB_TOKEN in the secure form, with the site https://github.com.';
const PAYLOAD_TOO_LARGE_STATUS = 413;
// A push can be large, so the body cap is higher than the one for connected apps.
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MIN_REDIRECT_STATUS = 300;
const MAX_REDIRECT_STATUS = 399;
const DENIED_MESSAGE = 'The owner did not approve this GitHub action, so it was not sent. Do not try it again unless the owner asks.';
const TOKEN_SITE_MESSAGE = 'The saved GitHub token is for another site, so the request was not sent.';
const UNREACHABLE_MESSAGE = 'GitHub could not be reached.';
const REDIRECT_MESSAGE = 'GitHub tried to redirect this request, so it was not followed.';
const TOO_LARGE_MESSAGE = 'The request is too large.';

function defaultFetch(url: URL, init: RequestInit): Promise<Response> {
    return fetch(url, init);
}

function sendJsonError(response: ServerResponse, statusCode: number, message: string): void {
    const errorResponse: ProxyErrorResponse = { error: message };

    response.writeHead(statusCode, { 'content-type': 'application/json' });
    const errorBody = JSON.stringify(errorResponse);

    response.end(errorBody);
}

function isRedirect(statusCode: number): boolean {
    return statusCode >= MIN_REDIRECT_STATUS && statusCode <= MAX_REDIRECT_STATUS;
}

// Each bot gets its own listener and port. The port is the bot's address, so one bot's shell has no other bot's address in its environment.
class GithubProxy {
    private readonly readToken: (botId: string) => string | undefined;
    private readonly approve: GithubProxyOptions['approve'];
    private readonly key: string;
    private readonly cert: string;
    private readonly caFile: string;
    private readonly bundleFile: string;
    private readonly fetchFunction: GithubFetch;
    private readonly portsByBot = new Map<string, Promise<number>>();
    private readonly botsWithPendingApproval = new Set<string>();
    private readonly servers: Server[] = [];

    constructor(options: GithubProxyOptions) {
        this.readToken = options.readToken;
        this.approve = options.approve;
        this.key = options.key;
        this.cert = options.cert;
        this.caFile = options.caFile;
        this.bundleFile = options.bundleFile;
        this.fetchFunction = options.fetchFunction ?? defaultFetch;
    }

    // The variables that point gh and git at this bot's listener. The turn adds them to the agent's environment.
    async environmentFor(botId: string): Promise<Record<string, string>> {
        const port = await this.portFor(botId);

        return buildGithubEnvironment({ port, caFile: this.caFile, bundleFile: this.bundleFile });
    }

    async close(): Promise<void> {
        const closing = this.servers.map(server => new Promise<void>((resolve) => {
            server.close(() => {
                resolve();
            });
            server.closeAllConnections();
        }));

        await Promise.all(closing);
    }

    private portFor(botId: string): Promise<number> {
        const started = this.portsByBot.get(botId);

        if (started !== undefined) {
            return started;
        }

        const listening = this.listen(botId);

        this.portsByBot.set(botId, listening);
        // A listener that failed to start is forgotten, so the next turn tries again.
        listening.catch(() => {
            this.portsByBot.delete(botId);
        });

        return listening;
    }

    private async listen(botId: string): Promise<number> {
        const server = createServer({ key: this.key, cert: this.cert }, (incomingRequest, outgoingResponse) => {
            this.handle(botId, incomingRequest, outgoingResponse)
                .catch(() => {
                    // The error is not logged, since it could carry request details. The client only sees a generic message.
                    if (outgoingResponse.headersSent) {
                        outgoingResponse.destroy();

                        return;
                    }

                    sendJsonError(outgoingResponse, BAD_GATEWAY_STATUS, UNREACHABLE_MESSAGE);
                });
        });

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, LOOPBACK_HOST, () => {
                resolve();
            });
        });

        const address = server.address() as AddressInfo;

        this.servers.push(server);

        return address.port;
    }

    private async handle(botId: string, incomingRequest: IncomingMessage, outgoingResponse: ServerResponse): Promise<void> {
        let requestBody: Buffer;

        try {
            requestBody = await readCapped(incomingRequest, MAX_REQUEST_BYTES);
        } catch (error: unknown) {
            if (error instanceof BodyTooLargeError) {
                sendJsonError(outgoingResponse, PAYLOAD_TOO_LARGE_STATUS, TOO_LARGE_MESSAGE);

                return;
            }

            throw error;
        }

        const classification = classifyGithubRequest(incomingRequest.method ?? '', incomingRequest.url ?? '/', requestBody);

        if (!classification.isAllowed) {
            sendJsonError(outgoingResponse, classification.statusCode, classification.reason);

            return;
        }

        const plan = classification.plan;
        let token: string | undefined;

        try {
            token = this.readToken(botId);
        } catch {
            sendJsonError(outgoingResponse, BAD_GATEWAY_STATUS, TOKEN_SITE_MESSAGE);

            return;
        }

        // Without a token GitHub would refuse the request anyway, so the owner is not asked about it.
        if (token === undefined && plan.needsToken) {
            sendJsonError(outgoingResponse, UNAUTHORIZED_STATUS, NO_TOKEN_MESSAGE);

            return;
        }

        // The owner decides before anything is sent. Reads pass without a card.
        if (plan.isWrite) {
            if (this.botsWithPendingApproval.has(botId)) {
                sendJsonError(outgoingResponse, TOO_MANY_REQUESTS_STATUS, PENDING_APPROVAL_MESSAGE);

                return;
            }

            const isApproved = await this.askOwnerOnce(botId, plan.summary, plan.detail);

            if (!isApproved) {
                sendJsonError(outgoingResponse, FORBIDDEN_STATUS, DENIED_MESSAGE);

                return;
            }
        }

        const headers = buildUpstreamHeaders(incomingRequest.headers, token, plan.isGit);
        // Redirects are not followed, so the token never goes to an address the proxy did not choose.
        const upstreamInit: RequestInit = {
            method: plan.method,
            headers,
            body: requestBody.length > 0 ? requestBody : null,
            redirect: 'manual',
        };
        const upstreamResponse = await this.fetchFunction(plan.upstream, upstreamInit);

        if (isRedirect(upstreamResponse.status)) {
            await upstreamResponse.body?.cancel();
            sendJsonError(outgoingResponse, BAD_GATEWAY_STATUS, REDIRECT_MESSAGE);

            return;
        }

        const responseHeaders = buildResponseHeaders(upstreamResponse.headers);

        outgoingResponse.writeHead(upstreamResponse.status, responseHeaders);

        if (upstreamResponse.body === null) {
            outgoingResponse.end();

            return;
        }

        const upstreamStream = Readable.fromWeb(upstreamResponse.body);

        pipeline(upstreamStream, outgoingResponse, () => {
            // A stream that ends early is the client or GitHub going away. Nothing else to report.
        });
    }

    // Marks the bot as waiting while its card is open, so a second write is refused rather than asked too.
    private async askOwnerOnce(botId: string, summary: string, detail: string | undefined): Promise<boolean> {
        this.botsWithPendingApproval.add(botId);

        try {
            return await this.approve(botId, summary, detail);
        } finally {
            this.botsWithPendingApproval.delete(botId);
        }
    }
}

export { GithubProxy };
export type { GithubFetch, GithubProxyOptions };
