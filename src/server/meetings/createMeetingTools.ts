import { z } from 'zod/v4';

import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool, CloudbotToolResult } from '../agent/cloudbotTool.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import { BrowserError } from '../desktop/BrowserControl.ts';
import { MeetingRecorderError } from './MeetingRecorder.ts';
import type { MeetingRecorder } from './MeetingRecorder.ts';

const MEETING_START_TOOL_NAME = 'meeting_record_start';
const MEETING_STATUS_TOOL_NAME = 'meeting_record_status';
const MEETING_STOP_TOOL_NAME = 'meeting_record_stop';
const MEETING_TOOL_FULL_NAMES = [MEETING_START_TOOL_NAME, MEETING_STATUS_TOOL_NAME, MEETING_STOP_TOOL_NAME].map(name => `mcp__${PROFILE_SERVER_NAME}__${name}`);

function textResult(text: string, isError = false): CloudbotToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function describeError(error: unknown): string {
    return error instanceof MeetingRecorderError || error instanceof BrowserError ? error.message : 'The recording could not start. Try again.';
}

// The bot joins with its browser tools. These tools only record and transcribe the call on its screen.
function createMeetingTools(recorder: MeetingRecorder, botId: string): CloudbotTool[] {
    const startTool = tool(
        MEETING_START_TOOL_NAME,
        'Start recording and transcribing the Google Meet call on your screen, only when the owner asked you to take notes of a meeting. '
        + 'Before this: open the link the owner gave with browser_open, turn off the camera and the microphone, join as a guest named "<your name> (notes for <owner>)", '
        + 'and wait until you are let in. Then say in the meeting chat who you are and that you take notes. '
        + 'If the meeting shows a recording or consent notice, tell the owner in the chat. '
        + 'Keep the meeting on the screen until you stop. The text is made in 5 minute parts with a local model, so it lags a few minutes behind. '
        + 'When the meeting ends without you, the recording stops by itself and you get a message with the transcript.',
        {
            language: z.string()
                .max(10)
                .optional()
                .describe('The language spoken, such as "pt" or "en". Leave it out to detect it.'),
        },
        async ({ language }): Promise<CloudbotToolResult> => {
            try {
                await recorder.start(botId, language);
            } catch (error: unknown) {
                const message = describeError(error);

                return textResult(message, true);
            }

            return textResult('Recording. Use meeting_record_status for the text so far and meeting_record_stop when the owner asks you to leave.');
        },
    );
    const statusTool = tool(
        MEETING_STATUS_TOOL_NAME,
        'Show the transcript so far of the meeting you are recording.',
        {},
        (): Promise<CloudbotToolResult> => {
            const status = recorder.status(botId);

            return Promise.resolve(status === undefined ? textResult('You are not recording a meeting.', true) : textResult(status));
        },
    );
    const stopTool = tool(
        MEETING_STOP_TOOL_NAME,
        'Stop recording the meeting and save the transcript. Waits for the last part to be transcribed, which can take a few minutes. '
        + 'Then leave the call with the browser tools, read the transcript and post a short summary with the action items, and share the file.',
        {},
        async (): Promise<CloudbotToolResult> => {
            const result = await recorder.stop(botId);

            if (result === undefined) {
                return textResult('You are not recording a meeting.', true);
            }

            const failures = result.failedSegments === 0 ? '' : ` ${String(result.failedSegments)} part(s) could not be transcribed.`;

            return textResult(`Saved the transcript to ${result.transcriptPath} with ${String(result.lineCount)} line(s).${failures}`);
        },
    );

    return [startTool, statusTool, stopTool] as CloudbotTool[];
}

export { MEETING_START_TOOL_NAME, MEETING_STATUS_TOOL_NAME, MEETING_STOP_TOOL_NAME, MEETING_TOOL_FULL_NAMES, createMeetingTools };
