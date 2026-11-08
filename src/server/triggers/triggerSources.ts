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
    // Returns a problem for a target that cannot be used. A source may also check it against the interval.
    checkTarget: (target: string, intervalMinutes: number) => string | undefined;
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
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars';
const CALENDAR_SERVER_NAME = 'google-calendar';
const CALENDAR_ID_PATTERN = /^[\w.@#+-]{1,200}$/;
const MINUTE_MS = 60 * 1000;
// A check can be a day apart, so a new event is looked for in a little more than a day.
const CALENDAR_LOOKBACK_MS = 26 * 60 * MINUTE_MS;
const CALENDAR_GRACE_MS = 2 * MINUTE_MS;
const MIN_LEAD_MINUTES = 10;
const MAX_LEAD_MINUTES = 24 * 60;
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

// Returns the check that tells the app is not connected, for a source of a Google app from Connect apps.
function googleReady(serverName: string, label: string): TriggerSource['checkReady'] {
    return async (_botId, deps) => {
        const token = await deps.googleToken(serverName);

        return token === undefined ? `${label} is not connected. Ask the owner to connect ${label} in Connect apps first.` : undefined;
    };
}

async function googleToken(serverName: string, label: string, deps: SourceDeps): Promise<string> {
    const token = await deps.googleToken(serverName);

    if (token === undefined) {
        throw new Error(`${label} is not connected.`);
    }

    return token;
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
    checkReady: googleReady(GMAIL_SERVER_NAME, 'Gmail'),
    poll: async (target, seen, _botId, deps) => {
        const token = await googleToken(GMAIL_SERVER_NAME, 'Gmail', deps);

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

function checkCalendarId(calendarId: string): string | undefined {
    return CALENDAR_ID_PATTERN.test(calendarId) ? undefined : 'The calendar must be "primary" or the address of a calendar.';
}

function isDeclined(event: Record<string, unknown>): boolean {
    return asArray(event['attendees'])
        .map(asRecord)
        .some(attendee => attendee['self'] === true && attendee['responseStatus'] === 'declined');
}

// A cancelled or declined event is not worth a message. The text is app content, so it stays on one line.
function readCalendarEvent(value: unknown, prefix: string): TriggerEvent | undefined {
    const event = asRecord(value);
    const id: unknown = event['id'];

    if (typeof id !== 'string' || event['status'] === 'cancelled' || isDeclined(event)) {
        return undefined;
    }

    const start = asRecord(event['start']);
    const when = oneLine(start['dateTime'] ?? start['date'], 40);
    const organizer = oneLine(asRecord(event['organizer'])['email'], 100);
    const title = oneLine(event['summary']) || 'No title';

    return { id, text: `${prefix} "${title}" starts ${when}, organizer ${organizer} ${oneLine(event['htmlLink'])}` };
}

function calendarEventsUrl(calendarId: string, query: Record<string, string>): string {
    return `${CALENDAR_API}/${encodeURIComponent(calendarId)}/events?${new URLSearchParams(query)
        .toString()}`;
}

async function listCalendarEvents(url: string, deps: SourceDeps): Promise<unknown[]> {
    const token = await googleToken(CALENDAR_SERVER_NAME, 'Google Calendar', deps);

    return asArray(asRecord(await deps.getJson(url, token))['items']);
}

// The target is a calendar address, or empty for the main calendar. It lists the events added in the last day,
// by the time they were created, so editing an old event does not count as new.
const calendarNewEventSource: TriggerSource = {
    id: 'calendar_new_event',
    label: 'Google Calendar new events',
    targetHelp: 'a calendar address, or empty for the main calendar. Google Calendar must be connected in Connect apps',
    checkTarget: target => (target === '' ? undefined : checkCalendarId(target)),
    checkReady: googleReady(CALENDAR_SERVER_NAME, 'Google Calendar'),
    poll: async (target, seen, _botId, deps) => {
        const since = Date.now() - CALENDAR_LOOKBACK_MS;
        const maxResults = String(MAX_ITEMS);
        const updatedMin = new Date(since)
            .toISOString();
        const url = calendarEventsUrl(target === '' ? 'primary' : target, { updatedMin, orderBy: 'updated', maxResults });
        const rows = await listCalendarEvents(url, deps);
        const isRecent = (row: unknown): boolean => {
            const createdText = oneLine(asRecord(row)['created'], 40);

            return Date.parse(createdText) >= since;
        };
        // The list is oldest change first, and the seen list is newest first.
        const items = rows.filter(isRecent)
            .map(row => readCalendarEvent(row, 'New event'))
            .filter((item): item is TriggerEvent => item !== undefined)
            .reverse();

        return split(items, seen);
    },
};

// The target is the minutes before the start, then an optional calendar address: "15" or "15 team@example.com".
function readStartingTarget(target: string): { minutes: number; calendarId: string } | undefined {
    const match = /^(\d{1,4})(?: (\S+))?$/.exec(target);

    if (match === null) {
        return undefined;
    }

    const minutes = Number(match[1]);

    return minutes < MIN_LEAD_MINUTES || minutes > MAX_LEAD_MINUTES ? undefined : { minutes, calendarId: match[2] ?? 'primary' };
}

// An event is reported once, when it first falls within the lead time. A check only sees the next `minutes`,
// so a check that comes less often than that could miss an event, and the target is refused then.
const calendarStartingSource: TriggerSource = {
    id: 'calendar_starting',
    label: 'Google Calendar starting events',
    targetHelp: `the minutes before an event starts (${String(MIN_LEAD_MINUTES)} to ${String(MAX_LEAD_MINUTES)}), then optionally a calendar address, such as "15" or "15 team@example.com". The interval must not be longer than these minutes. Google Calendar must be connected in Connect apps`,
    checkTarget: (target, intervalMinutes) => {
        const parsed = readStartingTarget(target);

        if (parsed === undefined) {
            return `The target must be the minutes before the start (${String(MIN_LEAD_MINUTES)} to ${String(MAX_LEAD_MINUTES)}), then optionally a calendar address.`;
        }

        if (intervalMinutes > parsed.minutes) {
            return 'The interval is longer than the minutes before the start, so an event could be missed. Use a shorter interval or more minutes.';
        }

        return checkCalendarId(parsed.calendarId);
    },
    checkReady: googleReady(CALENDAR_SERVER_NAME, 'Google Calendar'),
    poll: async (target, seen, _botId, deps) => {
        const parsed = readStartingTarget(target);

        if (parsed === undefined) {
            throw new Error('The target is not valid.');
        }

        const now = Date.now();
        const url = calendarEventsUrl(parsed.calendarId, {
            // A little before now, because checks run up to half a minute later than the interval.
            timeMin: new Date(now - CALENDAR_GRACE_MS)
                .toISOString(),
            timeMax: new Date(now + parsed.minutes * MINUTE_MS)
                .toISOString(),
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: String(MAX_ITEMS),
        });
        const rows = await listCalendarEvents(url, deps);
        // The list holds events that already began and have not ended, which are not "starting".
        const hasStarted = (row: unknown): boolean => {
            const startText = oneLine(asRecord(asRecord(row)['start'])['dateTime'], 40);

            return Date.parse(startText) < now - CALENDAR_GRACE_MS;
        };
        const items = rows.filter(row => !hasStarted(row))
            .map(row => readCalendarEvent(row, 'Event'))
            .filter((item): item is TriggerEvent => item !== undefined);

        return split(items, seen);
    },
};

const TRIGGER_SOURCES: TriggerSource[] = [
    githubSource('github_issues', 'GitHub issues', 'Issue', 'issues', false),
    githubSource('github_pulls', 'GitHub pull requests', 'Pull request', 'pulls', true),
    gmailSource,
    calendarNewEventSource,
    calendarStartingSource,
];

function findTriggerSource(id: string): TriggerSource | undefined {
    return TRIGGER_SOURCES.find(source => source.id === id);
}

export { TRIGGER_SOURCES, findTriggerSource, oneLine };
export type { PollResult, SourceDeps, TriggerEvent, TriggerSource };
