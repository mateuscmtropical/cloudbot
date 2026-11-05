import { describe, expect, it } from 'vitest';

import type { PageElement, PageText } from '../desktop/BrowserControl.ts';
import { MAX_KNOCKS, MeetingJoinError, joinMeeting } from './joinMeeting.ts';
import type { JoinBrowser } from './joinMeeting.ts';

const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const NAME = 'Ana (notes for Bia)';
const NAME_REF = 1;
const CAMERA_REF = 2;
const MICROPHONE_REF = 3;
const JOIN_REF = 4;
const LEAVE_REF = 9;

const LOBBY_ELEMENTS: PageElement[] = [
    { ref: NAME_REF, role: 'textbox', name: 'Your name' },
    { ref: CAMERA_REF, role: 'button', name: 'Turn off camera (ctrl + e)' },
    { ref: MICROPHONE_REF, role: 'button', name: 'Turn off microphone (ctrl + d)' },
    { ref: JOIN_REF, role: 'button', name: 'Ask to join' },
];
const CALL_ELEMENTS: PageElement[] = [{ ref: LEAVE_REF, role: 'button', name: 'Leave call' }];

// blank is a page that shows none of the answers, such as a page still loading.
type Answer = 'joined' | 'waiting' | 'refused' | 'blank';

interface FakeOptions {
    answers: Answer[];
    startsInCall?: boolean;
    formless?: boolean;
}

interface FakeCalls {
    opened: string[];
    clicked: number[];
    names: string[];
}

function page(text: string, elements: PageElement[]): PageText {
    return { title: 'Meet', url: MEET_URL, text, isTruncated: false, elements };
}

function answerPage(answer: Answer): PageText {
    if (answer === 'refused') {
        return page('You can’t join this video call', []);
    }

    if (answer === 'waiting') {
        return page('Asking to be let in...', []);
    }

    if (answer === 'joined') {
        return page('', CALL_ELEMENTS);
    }

    return page('Loading', []);
}

// Each knock opens the lobby. Clicking Ask to join gives the next answer, and the last answer repeats.
function fakeBrowser(options: FakeOptions): { browser: JoinBrowser; calls: FakeCalls } {
    const calls: FakeCalls = { opened: [], clicked: [], names: [] };
    const state = { inLobby: true, answered: 0 };
    const lobby = (): PageText => {
        if (options.startsInCall === true) {
            return page('', CALL_ELEMENTS);
        }

        if (options.formless === true) {
            return page('Loading', []);
        }

        return page('Ready to join?', LOBBY_ELEMENTS);
    };
    const current = (): PageText => {
        if (state.inLobby) {
            return lobby();
        }

        const index = Math.min(state.answered, options.answers.length - 1);
        const answer = options.answers[index] ?? 'blank';

        state.answered += 1;

        return answerPage(answer);
    };
    const browser: JoinBrowser = {
        open: (url: string) => {
            calls.opened.push(url);
            state.inLobby = true;

            return Promise.resolve(lobby());
        },
        read: () => Promise.resolve(current()),
        clickElement: (ref: number) => {
            calls.clicked.push(ref);

            if (ref === JOIN_REF) {
                state.inLobby = false;
            }

            return Promise.resolve({ hasFocusedField: false });
        },
        replaceFocusedText: (text: string) => {
            calls.names.push(text);

            return Promise.resolve();
        },
    };

    return { browser, calls };
}

// Meet's pauses are skipped in tests, so the knock loop runs at once.
const noWait = (): Promise<void> => Promise.resolve();

describe('joinMeeting', () => {
    it('knocks again after two refusals and reports the waiting room', async () => {
        const { browser, calls } = fakeBrowser({ answers: ['refused', 'refused', 'waiting'] });

        await expect(joinMeeting({ browser, url: MEET_URL, name: NAME, sleep: noWait }))
            .resolves.toEqual({ outcome: 'waiting', knocks: 3 });
        expect(calls.opened)
            .toHaveLength(3);
        expect(calls.names)
            .toEqual([NAME, NAME, NAME]);
        expect(calls.clicked.filter(ref => ref === JOIN_REF))
            .toHaveLength(3);
        expect(calls.clicked.filter(ref => ref === CAMERA_REF))
            .toHaveLength(3);
        expect(calls.clicked.filter(ref => ref === MICROPHONE_REF))
            .toHaveLength(3);
    });

    it('stops after the knock limit when Meet refuses every knock', async () => {
        const { browser, calls } = fakeBrowser({ answers: ['refused'] });

        expect(MAX_KNOCKS)
            .toBe(10);
        await expect(joinMeeting({ browser, url: MEET_URL, name: NAME, sleep: noWait }))
            .resolves.toEqual({ outcome: 'refused', knocks: MAX_KNOCKS });
        expect(calls.opened)
            .toHaveLength(MAX_KNOCKS);
    });

    it('reports a call the bot is already in, without knocking', async () => {
        const { browser, calls } = fakeBrowser({ answers: [], startsInCall: true });

        await expect(joinMeeting({ browser, url: MEET_URL, name: NAME, sleep: noWait }))
            .resolves.toEqual({ outcome: 'joined', knocks: 1 });
        expect(calls.clicked)
            .toEqual([]);
    });

    it('reports joined when the knock is let in at once', async () => {
        const { browser, calls } = fakeBrowser({ answers: ['joined'] });

        await expect(joinMeeting({ browser, url: MEET_URL, name: NAME, sleep: noWait }))
            .resolves.toEqual({ outcome: 'joined', knocks: 1 });
        expect(calls.opened)
            .toHaveLength(1);
    });

    it('reports no answer when the page shows none of the answers, and does not knock again', async () => {
        const { browser, calls } = fakeBrowser({ answers: ['blank'] });

        await expect(joinMeeting({ browser, url: MEET_URL, name: NAME, sleep: noWait }))
            .resolves.toEqual({ outcome: undefined, knocks: 1 });
        expect(calls.opened)
            .toHaveLength(1);
    });

    it('refuses a link that is not a Google Meet link, without opening anything', async () => {
        const { browser, calls } = fakeBrowser({ answers: ['joined'] });

        await expect(joinMeeting({ browser, url: 'https://example.com/abc-defg-hij', name: NAME, sleep: noWait }))
            .rejects.toThrow(MeetingJoinError);
        expect(calls.opened)
            .toEqual([]);
    });

    it('says so when the lobby has no name field and no join button', async () => {
        const { browser } = fakeBrowser({ answers: ['joined'], formless: true });

        await expect(joinMeeting({ browser, url: MEET_URL, name: NAME, sleep: noWait }))
            .rejects.toThrow('Could not find the name field or the join button');
    });
});
