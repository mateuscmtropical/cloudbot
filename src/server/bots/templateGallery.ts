import { createHash } from 'node:crypto';

import { z } from 'zod/v4';

import type { BotTemplate } from './botTemplate.ts';
import { MAX_BLOCKED_TOOLS, MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, MAX_RULES, MAX_TITLE_LENGTH, isOneLine, parseBotTemplate } from './botTemplate.ts';
import { isToolRuleName } from '../rules/parseRuleInput.ts';
import { hasHiddenCode } from '../text/isHiddenCode.ts';

const DEFAULT_GALLERY_REPO = 'mateuscmtropical/cloudbot-templates';
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DOT_SEGMENTS = ['.', '..'];
const TEMPLATE_FOLDER = 'templates';
const INDEX_FILE_NAME = 'index.json';
const FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}\.json$/;
const API_ORIGIN = 'https://api.github.com';
const JSON_ACCEPT = 'application/vnd.github+json';
const RAW_ACCEPT = 'application/vnd.github.raw+json';
const NOT_FOUND_STATUS = 404;
const LIMIT_STATUSES = [403, 429];
const SUCCESS_MIN_STATUS = 200;
const SUCCESS_MAX_STATUS = 299;
const LIST_CACHE_MS = 60 * 60 * 1000;
const CARD_TTL_MS = 10 * 60 * 1000;
const MAX_INDEX_ENTRIES = 200;
const MAX_INDEX_BLOCKED_TOOLS = MAX_RULES * MAX_BLOCKED_TOOLS;
const LISTING_DESCRIPTION_CHARS = 200;
const FORK_ATTEMPTS = 6;
const FORK_WAIT_MS = 2000;
const GALLERY_UNREADABLE_MESSAGE = 'The template gallery could not be read right now. Try again later.';
const GITHUB_LIMIT_MESSAGE = 'GitHub limit reached for the template gallery. Try later.';
const INDEX_INVALID_MESSAGE = 'The template gallery index is not valid, so the gallery cannot be listed right now.';
const SHARE_INDEX_MESSAGE = 'The gallery index on GitHub could not be read, so the template was not shared.';
const INDEX_FULL_MESSAGE = 'The gallery index is full, so the template was not shared.';
const FORK_NOT_READY_MESSAGE = 'GitHub is still making your fork of the gallery, so the template was not shared. Ask again in a minute.';
const ONE_LINE_MESSAGE = 'Use one line of plain text without hidden characters.';
const TOOL_NAME_MESSAGE = 'Each blocked tool must be a tool name such as Bash or WebFetch.';

// The message is written for the model, so it can tell the owner what went wrong.
class GalleryError extends Error {}

interface GalleryRequest {
    method: string;
    url: URL;
    accept: string;
    // Only the share sends a token. Reads of the public gallery go out without one.
    token: string | undefined;
    body: string | undefined;
}

interface GalleryResponse {
    status: number;
    text: string;
}

type GalleryTransport = (request: GalleryRequest) => Promise<GalleryResponse>;

// One row of the gallery index, as listed to the owner. Descriptions are cut short here.
interface GalleryEntry {
    file: string;
    name: string;
    title: string;
    description: string;
    blockedTools: string[];
}

interface FetchedTemplate {
    file: string;
    text: string;
    digest: string;
    template: BotTemplate;
}

interface PendingCard {
    digest: string;
    shownAt: number;
}

// The answer of a card check. Expired covers a card that is gone, past its time, or already used.
type CardCheck = 'approved' | 'expired' | 'changed';

interface ListCache {
    entries: GalleryEntry[];
    readAt: number;
}

interface SharePlan {
    token: string;
    fileName: string;
    text: string;
    botName: string;
}

interface TemplateGalleryOptions {
    repo: string;
    transport: GalleryTransport;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
}

const toolNameSchema = z.string()
    .trim()
    .min(1)
    .refine(name => !hasHiddenCode(name) && isToolRuleName(name), TOOL_NAME_MESSAGE);

// The same field checks as a template, applied to each row of the index.
const indexEntrySchema = z.object({
    file: z.string()
        .regex(FILE_NAME_PATTERN)
        .refine(file => file !== INDEX_FILE_NAME),
    name: z.string()
        .trim()
        .min(1)
        .max(MAX_NAME_LENGTH)
        .refine(isOneLine, ONE_LINE_MESSAGE),
    title: z.string()
        .trim()
        .min(1)
        .max(MAX_TITLE_LENGTH)
        .refine(isOneLine, ONE_LINE_MESSAGE),
    description: z.string()
        .trim()
        .max(MAX_DESCRIPTION_LENGTH),
    blockedTools: z.array(toolNameSchema)
        .max(MAX_INDEX_BLOCKED_TOOLS),
})
    .strict();

function isSuccess(status: number): boolean {
    return status >= SUCCESS_MIN_STATUS && status <= SUCCESS_MAX_STATUS;
}

// GitHub asks the client to wait when it is over its limit. Both statuses get the same owner message.
function isLimit(status: number): boolean {
    return LIMIT_STATUSES.includes(status);
}

function failureMessage(status: number): string {
    return isLimit(status) ? GITHUB_LIMIT_MESSAGE : GALLERY_UNREADABLE_MESSAGE;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function readString(record: unknown, fieldName: string): string | undefined {
    if (typeof record !== 'object' || record === null) {
        return undefined;
    }

    const value: unknown = Reflect.get(record, fieldName);

    return typeof value === 'string' ? value : undefined;
}

function readField(record: unknown, fieldName: string): unknown {
    if (typeof record !== 'object' || record === null) {
        return undefined;
    }

    return Reflect.get(record, fieldName);
}

function digestOf(text: string): string {
    const hash = createHash('sha256');

    hash.update(text);

    return hash.digest('hex');
}

function jsonBody(value: unknown): string {
    return JSON.stringify(value);
}

function contentsPath(repo: string, file: string): string {
    return `/repos/${repo}/contents/${TEMPLATE_FOLDER}/${file}`;
}

function toListedEntry(entry: z.infer<typeof indexEntrySchema>): GalleryEntry {
    return {
        file: entry.file,
        name: entry.name,
        title: entry.title,
        description: entry.description.slice(0, LISTING_DESCRIPTION_CHARS),
        blockedTools: entry.blockedTools,
    };
}

// The index must be a list within the cap, or nothing is listed. A row that fails the checks is skipped.
function readIndex(text: string): GalleryEntry[] {
    const items = parseJson(text);

    if (!Array.isArray(items) || items.length > MAX_INDEX_ENTRIES) {
        throw new GalleryError(INDEX_INVALID_MESSAGE);
    }

    return items.flatMap((item: unknown) => {
        const parsed = indexEntrySchema.safeParse(item);

        return parsed.success ? [toListedEntry(parsed.data)] : [];
    });
}

// The index row for a template that is being shared. It is built from the template that passed the checks.
function indexRowFor(file: string, template: BotTemplate): Record<string, unknown> {
    const blockedTools = (template.rules ?? []).flatMap(rule => rule.blockedTools);

    return { file, name: template.name, title: template.title, description: template.description, blockedTools };
}

async function defaultWait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

// Reads the public gallery and shares templates into it. Everything read from the gallery is untrusted,
// so each template goes through the import checks before anyone sees it.
class TemplateGallery {
    private readonly repo: string;
    private readonly transport: GalleryTransport;
    private readonly now: () => number;
    private readonly wait: (ms: number) => Promise<void>;
    private listCache: ListCache | undefined;
    private readonly pendingCards = new Map<string, PendingCard>();

    constructor(options: TemplateGalleryOptions) {
        this.repo = options.repo;
        this.transport = options.transport;
        this.now = options.now ?? Date.now;
        this.wait = options.wait ?? defaultWait;
    }

    repository(): string {
        return this.repo;
    }

    // The listing comes from one file, templates/index.json, so a listing costs one GitHub read.
    // A good listing is kept for an hour. A failed read is never kept.
    async listTemplates(): Promise<GalleryEntry[]> {
        const readAt = this.now();
        const cached = this.listCache;

        if (cached !== undefined && readAt - cached.readAt <= LIST_CACHE_MS) {
            return cached.entries;
        }

        const indexPath = contentsPath(this.repo, INDEX_FILE_NAME);
        const response = await this.request('GET', indexPath, RAW_ACCEPT, undefined, undefined);

        if (!isSuccess(response.status)) {
            const listMessage = failureMessage(response.status);

            throw new GalleryError(listMessage);
        }

        const entries = readIndex(response.text);

        this.listCache = { entries, readAt };

        return entries;
    }

    // Reads one template as the owner will see it. The digest binds the card to these exact bytes.
    async fetchTemplate(file: string): Promise<FetchedTemplate> {
        if (!FILE_NAME_PATTERN.test(file) || file === INDEX_FILE_NAME) {
            throw new GalleryError('The template name is not a gallery file name. Use a name such as ana-mail.json from the gallery list.');
        }

        const path = contentsPath(this.repo, file);
        const response = await this.request('GET', path, RAW_ACCEPT, undefined, undefined);

        if (response.status === NOT_FOUND_STATUS) {
            throw new GalleryError('That template is not in the gallery. Use a name from the gallery list.');
        }

        if (!isSuccess(response.status)) {
            const fetchMessage = failureMessage(response.status);

            throw new GalleryError(fetchMessage);
        }

        const parsed = parseBotTemplate(response.text);

        if (!parsed.ok) {
            throw new GalleryError(`That gallery template is not valid. ${parsed.reason}`);
        }

        return { file, text: response.text, digest: digestOf(response.text), template: parsed.template };
    }

    // Whether the gallery already has a file with this name. The share card says so.
    async fileExists(file: string): Promise<boolean> {
        const path = contentsPath(this.repo, file);
        const response = await this.request('GET', path, RAW_ACCEPT, undefined, undefined);

        if (response.status === NOT_FOUND_STATUS) {
            return false;
        }

        if (!isSuccess(response.status)) {
            const existsMessage = failureMessage(response.status);

            throw new GalleryError(existsMessage);
        }

        return true;
    }

    // Shares a template from the owner's fork. The fork gets a new branch with the file and the index row,
    // then a pull request goes to the gallery. The branch is removed if any step fails.
    async openPullRequest(plan: SharePlan): Promise<string> {
        const parsed = parseBotTemplate(plan.text);

        if (!parsed.ok) {
            throw new GalleryError('The template is not valid, so it was not shared.');
        }

        const upstream = await this.expectSuccess('GET', `/repos/${this.repo}`, undefined, plan.token, 'read the gallery');
        const upstreamJson = parseJson(upstream.text);
        const defaultBranch = readString(upstreamJson, 'default_branch');

        if (defaultBranch === undefined) {
            throw new GalleryError(GALLERY_UNREADABLE_MESSAGE);
        }

        const forkResponse = await this.expectSuccess('POST', `/repos/${this.repo}/forks`, undefined, plan.token, 'fork the gallery');
        const forkJson = parseJson(forkResponse.text);
        const forkRepo = readString(forkJson, 'full_name');
        const forkOwnerRecord = readField(forkJson, 'owner');
        const forkOwner = readString(forkOwnerRecord, 'login');

        if (forkRepo === undefined || forkOwner === undefined) {
            throw new GalleryError(GALLERY_UNREADABLE_MESSAGE);
        }

        const baseSha = await this.readForkBase(forkRepo, defaultBranch, plan.token);
        const slug = plan.fileName.replace(/\.json$/, '');
        const stamp = this.now()
            .toString(36);
        const branch = `cloudbot-template-${slug}-${stamp}`;
        const refBody = jsonBody({ ref: `refs/heads/${branch}`, sha: baseSha });

        await this.expectSuccess('POST', `/repos/${forkRepo}/git/refs`, refBody, plan.token, 'create the branch');

        try {
            await this.writeFileAndIndex(forkRepo, branch, plan, parsed.template);

            return await this.openPull(forkOwner, branch, defaultBranch, plan);
        } catch (error: unknown) {
            await this.deleteBranch(forkRepo, branch, plan.token);

            throw error;
        }
    }

    // A card waits for the owner for ten minutes. A newer card for the same key replaces the older one.
    // Cards already past their time are dropped whenever a new one is added.
    rememberCard(key: string, digest: string): void {
        const now = this.now();

        this.pendingCards.forEach((card, cardKey) => {
            if (now - card.shownAt > CARD_TTL_MS) {
                this.pendingCards.delete(cardKey);
            }
        });
        this.pendingCards.set(key, { digest, shownAt: now });
    }

    // Every check removes the card, so an answer is used once, whatever its result.
    takeCard(key: string, digest: string): CardCheck {
        const card = this.pendingCards.get(key);

        this.pendingCards.delete(key);

        if (card === undefined || this.now() - card.shownAt > CARD_TTL_MS) {
            return 'expired';
        }

        return card.digest === digest ? 'approved' : 'changed';
    }

    // The fork may still be on its way when it is first asked for. Each try waits, up to a fixed count.
    private async readForkBase(forkRepo: string, branch: string, token: string, attempt = 1): Promise<string> {
        const response = await this.request('GET', `/repos/${forkRepo}/git/ref/heads/${branch}`, JSON_ACCEPT, token, undefined);

        if (isSuccess(response.status)) {
            const refJson = parseJson(response.text);
            const refObject = readField(refJson, 'object');
            const sha = readString(refObject, 'sha');

            if (sha === undefined) {
                throw new GalleryError(GALLERY_UNREADABLE_MESSAGE);
            }

            return sha;
        }

        if (attempt >= FORK_ATTEMPTS) {
            throw new GalleryError(FORK_NOT_READY_MESSAGE);
        }

        await this.wait(FORK_WAIT_MS);

        return this.readForkBase(forkRepo, branch, token, attempt + 1);
    }

    private async writeFileAndIndex(forkRepo: string, branch: string, plan: SharePlan, template: BotTemplate): Promise<void> {
        const existingSha = await this.existingFileSha(forkRepo, plan.fileName, branch, plan.token);

        await this.putFile(forkRepo, branch, plan.fileName, plan.text, `Add the ${plan.botName} template`, plan.token, existingSha);

        const index = await this.readBranchIndex(forkRepo, branch, plan.token);
        const others = index.items.filter(item => readString(item, 'file') !== plan.fileName);
        const nextRows = [...others, indexRowFor(plan.fileName, template)];

        if (nextRows.length > MAX_INDEX_ENTRIES) {
            throw new GalleryError(INDEX_FULL_MESSAGE);
        }

        const indexText = `${JSON.stringify(nextRows, null, 2)}\n`;

        await this.putFile(forkRepo, branch, INDEX_FILE_NAME, indexText, `List the ${plan.botName} template`, plan.token, index.sha);
    }

    private async openPull(forkOwner: string, branch: string, defaultBranch: string, plan: SharePlan): Promise<string> {
        const pullBody = jsonBody({
            title: `Add the ${plan.botName} template`,
            head: `${forkOwner}:${branch}`,
            base: defaultBranch,
            body: `Shared from CloudBot. Adds templates/${plan.fileName} and lists it in templates/${INDEX_FILE_NAME}.`,
        });
        const pullResponse = await this.expectSuccess('POST', `/repos/${this.repo}/pulls`, pullBody, plan.token, 'open the pull request');
        const pullJson = parseJson(pullResponse.text);
        const pullUrl = readString(pullJson, 'html_url');

        if (pullUrl === undefined) {
            throw new GalleryError(GALLERY_UNREADABLE_MESSAGE);
        }

        return pullUrl;
    }

    private async putFile(repo: string, branch: string, file: string, text: string, message: string, token: string, sha: string | undefined): Promise<void> {
        const bytes = Buffer.from(text, 'utf8');
        const content = bytes.toString('base64');
        const body = jsonBody(sha === undefined
            ? { message, content, branch }
            : { message, content, branch, sha });

        const path = contentsPath(repo, file);

        await this.expectSuccess('PUT', path, body, token, 'add the file');
    }

    // The index row list on the branch. A missing index starts an empty list.
    private async readBranchIndex(forkRepo: string, branch: string, token: string): Promise<{ items: unknown[]; sha: string | undefined }> {
        const response = await this.request('GET', `${contentsPath(forkRepo, INDEX_FILE_NAME)}?ref=${branch}`, JSON_ACCEPT, token, undefined);

        if (response.status === NOT_FOUND_STATUS) {
            return { items: [], sha: undefined };
        }

        if (!isSuccess(response.status)) {
            throw new GalleryError(SHARE_INDEX_MESSAGE);
        }

        const json = parseJson(response.text);
        const encoded = readString(json, 'content') ?? '';
        const cleaned = encoded.replace(/\s/g, '');
        const bytes = Buffer.from(cleaned, 'base64');
        const decoded = bytes.toString('utf8');
        const items = parseJson(decoded);

        if (!Array.isArray(items)) {
            throw new GalleryError(SHARE_INDEX_MESSAGE);
        }

        return { items, sha: readString(json, 'sha') };
    }

    // The branch is removed when the share fails. If GitHub refuses the removal, the owner deletes it by hand.
    private async deleteBranch(forkRepo: string, branch: string, token: string): Promise<void> {
        try {
            await this.request('DELETE', `/repos/${forkRepo}/git/refs/heads/${branch}`, JSON_ACCEPT, token, undefined);
        } catch {
            // The share already failed, so this error is not reported over the first one.
        }
    }

    private async existingFileSha(repo: string, fileName: string, branch: string, token: string): Promise<string | undefined> {
        const path = `${contentsPath(repo, fileName)}?ref=${branch}`;
        const response = await this.request('GET', path, JSON_ACCEPT, token, undefined);

        if (response.status === NOT_FOUND_STATUS) {
            return undefined;
        }

        if (!isSuccess(response.status)) {
            const existingMessage = failureMessage(response.status);

            throw new GalleryError(existingMessage);
        }

        const existingJson = parseJson(response.text);

        return readString(existingJson, 'sha');
    }

    private async expectSuccess(method: string, path: string, body: string | undefined, token: string, step: string): Promise<GalleryResponse> {
        const response = await this.request(method, path, JSON_ACCEPT, token, body);

        if (isLimit(response.status)) {
            throw new GalleryError(GITHUB_LIMIT_MESSAGE);
        }

        if (!isSuccess(response.status)) {
            throw new GalleryError(`GitHub refused to ${step} (status ${String(response.status)}), so the template was not shared.`);
        }

        return response;
    }

    private request(method: string, path: string, accept: string, token: string | undefined, body: string | undefined): Promise<GalleryResponse> {
        const url = new URL(path, API_ORIGIN);

        return this.transport({ method, url, accept, token, body });
    }
}

// The name of the gallery repository from the environment. An empty value keeps the default.
function readGalleryRepo(value: string | undefined): string {
    const repo = value === undefined || value.trim() === '' ? DEFAULT_GALLERY_REPO : value.trim();
    const segments = repo.split('/');
    const hasDotSegment = segments.some(segment => DOT_SEGMENTS.includes(segment));

    if (!REPO_PATTERN.test(repo) || hasDotSegment) {
        throw new Error('CLOUDBOT_GALLERY_REPO must be a GitHub repository in the form owner/name.');
    }

    return repo;
}

export { DEFAULT_GALLERY_REPO, FILE_NAME_PATTERN, GalleryError, TemplateGallery, digestOf, readGalleryRepo };
export type { CardCheck, FetchedTemplate, GalleryEntry, GalleryRequest, GalleryResponse, GalleryTransport, SharePlan, TemplateGalleryOptions };
