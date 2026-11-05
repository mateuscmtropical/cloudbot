import type { BrowserControl, PageElement, PageText } from '../desktop/BrowserControl.ts';
import { isMeetingUrl } from './MeetingRecorder.ts';
import { CAMERA_ON_PATTERN, JOIN_PATTERN, LEAVE_CALL_PATTERN, MICROPHONE_ON_PATTERN, NAME_FIELD_PATTERN, REFUSED_PATTERN, WAITING_PATTERN } from './meetSelectors.ts';

type JoinBrowser = Pick<BrowserControl, 'open' | 'read' | 'clickElement' | 'replaceFocusedText'>;

// What Meet answers to a knock. Undefined when the page shows none of them.
type JoinOutcome = 'joined' | 'waiting' | 'refused';

interface JoinMeetingOptions {
    browser: JoinBrowser;
    url: string;
    name: string;
    // Waits between two reads of the page. Tests pass one that returns at once.
    sleep?: (delayMs: number) => Promise<void>;
}

interface JoinMeetingResult {
    outcome: JoinOutcome | undefined;
    knocks: number;
}

interface KnockContext {
    browser: JoinBrowser;
    url: string;
    name: string;
    sleep: (delayMs: number) => Promise<void>;
}

// A join problem the owner should hear about, such as a page without a name field.
class MeetingJoinError extends Error {}

// Meet refuses a guest knock at random, so the knock is repeated. The limit keeps the bot from knocking forever.
const MAX_KNOCKS = 10;
const POLL_MS = 2000;
// About 20 seconds of reads for the lobby, and about 20 seconds for the answer after a knock.
const LOBBY_POLLS = 10;
const ANSWER_POLLS = 10;

function defaultSleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, delayMs);
    });
}

function findElement(page: PageText, pattern: RegExp, role: string): PageElement | undefined {
    return page.elements.find(element => element.role === role && pattern.test(element.name));
}

function outcomeOf(page: PageText): JoinOutcome | undefined {
    if (REFUSED_PATTERN.test(page.text)) {
        return 'refused';
    }

    if (findElement(page, LEAVE_CALL_PATTERN, 'button') !== undefined) {
        return 'joined';
    }

    if (WAITING_PATTERN.test(page.text)) {
        return 'waiting';
    }

    return undefined;
}

function isLobbyReady(page: PageText): boolean {
    const hasForm = findElement(page, NAME_FIELD_PATTERN, 'textbox') !== undefined || findElement(page, JOIN_PATTERN, 'button') !== undefined;

    return hasForm || outcomeOf(page) !== undefined;
}

// Reads the page until it is done, or until the reads run out. The last read is returned either way.
async function readUntil(context: KnockContext, polls: number, isDone: (page: PageText) => boolean): Promise<PageText> {
    const page = await context.browser.read();

    if (polls <= 1 || isDone(page)) {
        return page;
    }

    await context.sleep(POLL_MS);

    return readUntil(context, polls - 1, isDone);
}

// Clicks the element that matches, reading the page first so an element that was re-drawn is not clicked by its old number.
async function clickIfPresent(context: KnockContext, pattern: RegExp, role: string): Promise<boolean> {
    const page = await context.browser.read();
    const element = findElement(page, pattern, role);

    if (element === undefined) {
        return false;
    }

    await context.browser.clickElement(element.ref);

    return true;
}

// One knock: open the call again, fill the form, turn the devices off and ask to join. Then read the answer.
async function knock(context: KnockContext): Promise<JoinOutcome | undefined> {
    await context.browser.open(context.url);

    const lobby = await readUntil(context, LOBBY_POLLS, isLobbyReady);
    const early = outcomeOf(lobby);

    if (early !== undefined) {
        return early;
    }

    const hasNameField = findElement(lobby, NAME_FIELD_PATTERN, 'textbox') !== undefined;
    const hasJoinButton = findElement(lobby, JOIN_PATTERN, 'button') !== undefined;

    if (!hasNameField && !hasJoinButton) {
        throw new MeetingJoinError('Could not find the name field or the join button on the Meet page. Open the call again and check the link.');
    }

    await clickIfPresent(context, CAMERA_ON_PATTERN, 'button');
    await clickIfPresent(context, MICROPHONE_ON_PATTERN, 'button');

    const nameFieldClicked = await clickIfPresent(context, NAME_FIELD_PATTERN, 'textbox');

    if (nameFieldClicked) {
        await context.browser.replaceFocusedText(context.name);
    }

    const joinClicked = await clickIfPresent(context, JOIN_PATTERN, 'button');

    if (!joinClicked) {
        throw new MeetingJoinError('Could not find the "Ask to join" button on the Meet page. Open the call again and check the link.');
    }

    const answer = await readUntil(context, ANSWER_POLLS, page => outcomeOf(page) !== undefined);

    return outcomeOf(answer);
}

// Knocks again after each refusal, up to the limit. Any other answer ends the knocks.
async function knockUntilAnswer(context: KnockContext, knocks: number): Promise<JoinMeetingResult> {
    const outcome = await knock(context);

    if (outcome !== 'refused' || knocks >= MAX_KNOCKS) {
        return { outcome, knocks };
    }

    return knockUntilAnswer(context, knocks + 1);
}

// Joins a Google Meet call as a guest. Returns what Meet answered, or throws a MeetingJoinError.
async function joinMeeting(options: JoinMeetingOptions): Promise<JoinMeetingResult> {
    if (!isMeetingUrl(options.url)) {
        throw new MeetingJoinError('Give a Google Meet link, such as https://meet.google.com/abc-defg-hij.');
    }

    const context: KnockContext = {
        browser: options.browser,
        url: options.url,
        name: options.name,
        sleep: options.sleep ?? defaultSleep,
    };

    return knockUntilAnswer(context, 1);
}

export { MAX_KNOCKS, MeetingJoinError, joinMeeting };
export type { JoinBrowser, JoinMeetingOptions, JoinMeetingResult, JoinOutcome };
