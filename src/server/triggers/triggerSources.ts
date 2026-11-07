// The apps a trigger can watch. A source lists the newest items of one target and tells which are new.
// Adding an app means adding one entry to TRIGGER_SOURCES. Everything else (schedule, dedupe, message, limits) is shared.

interface TriggerEvent {
    id: string;
    // One line. It is app content, so the scheduler shows it to the bot as outside data.
    text: string;
}

interface PollResult {
    // The ids of the newest items, newest first. They become the seen list.
    ids: string[];
    // The items that are not in `seen`, newest first. Empty on the baseline check.
    events: TriggerEvent[];
}

// What a source needs from the outside. Tests replace all of it.
interface SourceDeps {
    // Reads JSON from an https API address. It throws when the app does not answer well.
    getJson: (url: string, token: string | undefined) => Promise<unknown>;
    githubToken: (botId: string) => string | undefined;
    // The access token of a connected Google app, or undefined when it is not connected.
    googleToken: (serverName: string) => Promise<string | undefined>;
}

interface TriggerSource {
    id: string;
    label: string;
    // What the target is, for the tool description.
    targetHelp: string;
    // Returns a problem for a target that cannot be used.
    checkTarget: (target: string) => string | undefined;
    // Returns a problem when the app cannot be read yet, such as an app that is not connected.
    checkReady: (botId: string, deps: SourceDeps) => Promise<string | undefined>;
    // `seen` is undefined on the baseline check, and then no event is returned.
    poll: (target: string, seen: Set<string> | undefined, botId: string, deps: SourceDeps) => Promise<PollResult>;
}

const MAX_FIELD_LENGTH = 200;
const MAX_ITEMS = 30;
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const GMAIL_SERVER_NAME = 'google-gmail';
const GMAIL_MAX_ITEMS = 10;
const GITHUB_API = 'https://api.github.com/repos';
const REPO_PATTERN = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

// App content stays on one line, so an item cannot start a line that looks like part of the message.
function oneLine(value: unknown, maxLength = MAX_FIELD_LENGTH): string {
    const text = typeof value === 'string'
        ? value.replace(/\s+/g, ' ')
                .trim()
        : '';

    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function split(items: TriggerEvent[], seen: Set<string> | undefined): PollResult {
    return {
        ids: items.map(item => item.id),
        events: seen === undefined ? [] : items.filter(item => !seen.has(item.id)),
    };
}

function checkRepo(target: string): string | undefined {
    const isRepo = REPO_PATTERN.test(target) && !target.split('/')
        .some(part => part === '.' || part === '..');

    return isRepo ? undefined : 'The target must be a repository in the form owner/repo.';
}

function readGithubItem(value: unknown, noun: string): TriggerEvent | undefined {
    const item = asRecord(value);
    const number: unknown = item['number'];

    if (typeof number !== 'number') {
        return undefined;
    }

    const author = oneLine(asRecord(item['user'])['login'], 40);
    const body = oneLine(item['body']);
    const bodyText = body === '' ? '' : `: ${body}`;

    return { id: String(number), text: `${noun} #${String(number)} "${oneLine(item['title'])}" by ${author}${bodyText} ${oneLine(item['html_url'])}` };
}

// A repository's issues and pull requests share one number sequence, so the number is the id.
// The issues list also holds pull requests, which carry a `pull_request` field and are left out of it.
function githubSource(id: string, label: string, noun: string, path: string, isPullRequest: boolean): TriggerSource {
    return {
        id,
        label,
        targetHelp: 'a repository as owner/repo. A private repository needs the GitHub token of this bot',
        checkTarget: checkRepo,
        checkReady: () => Promise.resolve(undefined),
        poll: async (target, seen, botId, deps) => {
            const url = `${GITHUB_API}/${target}/${path}?state=all&sort=created&direction=desc&per_page=${String(MAX_ITEMS)}`;
            const token = deps.githubToken(botId);
            const rows = asArray(await deps.getJson(url, token));
            const matching = isPullRequest ? rows : rows.filter(row => asRecord(row)['pull_request'] === undefined);
            const items = matching.map(row => readGithubItem(row, noun))
                .filter((item): item is TriggerEvent => item !== undefined);

            return split(items, seen);
        },
    };
}

function readHeader(headers: unknown[], name: string): string {
    const found = headers.map(asRecord)
        .find(header => header['name'] === name);

    return oneLine(found?.['value'], 100);
}

// The target is a Gmail search, such as `from:ana@example.com`. The inbox is searched when it is empty.
const gmailSource: TriggerSource = {
    id: 'gmail',
    label: 'Gmail',
    targetHelp: 'a Gmail search such as "from:ana@example.com" or "in:inbox is:unread". Gmail must be connected in Connect apps',
    checkTarget: target => (target.length > MAX_FIELD_LENGTH ? 'The search is too long.' : undefined),
    checkReady: async (_botId, deps) => {
        const token = await deps.googleToken(GMAIL_SERVER_NAME);

        return token === undefined ? 'Gmail is not connected. Ask the owner to connect Gmail in Connect apps first.' : undefined;
    },
    poll: async (target, seen, _botId, deps) => {
        const token = await deps.googleToken(GMAIL_SERVER_NAME);

        if (token === undefined) {
            throw new Error('Gmail is not connected.');
        }

        const query = target === '' ? 'in:inbox' : target;
        const list = asRecord(await deps.getJson(`${GMAIL_API}?maxResults=${String(GMAIL_MAX_ITEMS)}&q=${encodeURIComponent(query)}`, token));
        const ids = asArray(list['messages'])
            .map(message => asRecord(message)['id'])
            .filter((id): id is string => typeof id === 'string');

        if (seen === undefined) {
            return { ids, events: [] };
        }

        const newIds = ids.filter(id => !seen.has(id));
        const readOne = async (id: string): Promise<TriggerEvent> => {
            const url = `${GMAIL_API}/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`;
            const message = asRecord(await deps.getJson(url, token));
            const headers = asArray(asRecord(message['payload'])['headers']);
            const snippet = oneLine(message['snippet']);

            return { id, text: `From ${readHeader(headers, 'From')}, subject "${readHeader(headers, 'Subject')}": ${snippet}` };
        };

        const reads = newIds.map(readOne);
        const events = await Promise.all(reads);

        return { ids, events };
    },
};

const TRIGGER_SOURCES: TriggerSource[] = [
    githubSource('github_issues', 'GitHub issues', 'Issue', 'issues', false),
    githubSource('github_pulls', 'GitHub pull requests', 'Pull request', 'pulls', true),
    gmailSource,
];

function findTriggerSource(id: string): TriggerSource | undefined {
    return TRIGGER_SOURCES.find(source => source.id === id);
}

export { TRIGGER_SOURCES, findTriggerSource, oneLine };
export type { PollResult, SourceDeps, TriggerEvent, TriggerSource };
