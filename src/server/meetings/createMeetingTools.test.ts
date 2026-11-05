import { describe, expect, it } from 'vitest';

import type { PageText } from '../desktop/BrowserControl.ts';
import type { CloudbotTool } from '../agent/cloudbotTool.ts';
import { MEETING_JOIN_TOOL_NAME, MEETING_TOOL_FULL_NAMES, createMeetingTools } from './createMeetingTools.ts';
import type { JoinBrowser } from './joinMeeting.ts';
import type { MeetingRecorder } from './MeetingRecorder.ts';

const CALL_PAGE: PageText = {
    title: 'Meet',
    url: 'https://meet.google.com/abc-defg-hij',
    text: '',
    isTruncated: false,
    elements: [{ ref: 9, role: 'button', name: 'Leave call' }],
};

// The call is already on the screen, so a join needs one read and no knock.
function callBrowser(): JoinBrowser {
    return {
        open: () => Promise.resolve(CALL_PAGE),
        read: () => Promise.resolve(CALL_PAGE),
        clickElement: () => Promise.resolve({ hasFocusedField: false }),
        replaceFocusedText: () => Promise.resolve(),
    };
}

function joinTool(browser: JoinBrowser): CloudbotTool {
    const tools = createMeetingTools({} as unknown as MeetingRecorder, 'bot-1', browser);
    const found = tools.find(entry => entry.name === MEETING_JOIN_TOOL_NAME);

    if (found === undefined) {
        throw new Error('No meeting_join tool');
    }

    return found;
}

describe('meeting_join tool', () => {
    it('is one of the allowed meeting tools', () => {
        expect(MEETING_TOOL_FULL_NAMES)
            .toContain('mcp__cloudbot__meeting_join');
    });

    it('says the bot is in the call when Meet lets it in', async () => {
        const callTool = joinTool(callBrowser());
        const result = await callTool.handler({ url: 'https://meet.google.com/abc-defg-hij', name: 'Ana' }, undefined);

        expect(result.isError)
            .toBeUndefined();
        expect(JSON.stringify(result.content))
            .toContain('Joined the call after 1 knock(s)');
    });

    it('returns an error for a link that is not a Google Meet link', async () => {
        const callTool = joinTool(callBrowser());
        const result = await callTool.handler({ url: 'https://example.com/call', name: 'Ana' }, undefined);

        expect(result.isError)
            .toBe(true);
        expect(JSON.stringify(result.content))
            .toContain('Give a Google Meet link');
    });
});
