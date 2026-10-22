import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';

interface ScreenToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

// Gives the screen to the owner and posts the handoff note in the chat. It throws when the note cannot be posted.
type ScreenRequestHandler = (reason: string) => Promise<void>;

const REQUEST_SCREEN_TOOL_NAME = 'request_screen';
const REQUEST_SCREEN_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${REQUEST_SCREEN_TOOL_NAME}`;
const MAX_REASON_LENGTH = 300;
const REQUEST_SCREEN_DESCRIPTION = 'Hand your screen to the owner when a site needs a person, for example a sign-in with a check you cannot pass. Give a short reason the owner will read. The owner gets a note in the chat. After this call the browser tools stop working. Tell the owner what to do and stop until they answer.';

const REQUEST_SCREEN_SHAPE = {
    reason: z.string()
        .trim()
        .min(1)
        .max(MAX_REASON_LENGTH),
};

function textResult(text: string, isError = false): ScreenToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function createRequestScreenTool(requestScreen: ScreenRequestHandler): CloudbotTool<typeof REQUEST_SCREEN_SHAPE> {
    return tool(
        REQUEST_SCREEN_TOOL_NAME,
        REQUEST_SCREEN_DESCRIPTION,
        REQUEST_SCREEN_SHAPE,
        async (args): Promise<ScreenToolResult> => {
            try {
                await requestScreen(args.reason);

                return textResult('The owner has the screen now. Your browser tools are paused. Tell the owner what they need to do, then stop and wait for their message.');
            } catch {
                return textResult('The screen could not be handed over.', true);
            }
        },
    );
}

const SCREEN_SHOW_TOOL_NAME = 'screen_show';
const SCREEN_SHOW_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${SCREEN_SHOW_TOOL_NAME}`;
const SCREEN_SHOW_DESCRIPTION = 'Open your screen for the owner in the chat, when the owner asks to see it. It hands nothing over and needs no approval.';

// Only opens the Screen panel. The handler is the ChatService's, so the web app is told the panel should open.
function createScreenShowTool(showScreen: () => void): CloudbotTool<Record<string, never>> {
    return tool(
        SCREEN_SHOW_TOOL_NAME,
        SCREEN_SHOW_DESCRIPTION,
        {},
        (): Promise<ScreenToolResult> => {
            showScreen();

            const result = textResult('The screen is open for the owner in the chat.');

            return Promise.resolve(result);
        },
    );
}

const SCREEN_RECORD_TOOL_NAME = 'screen_record';
const SCREEN_RECORD_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${SCREEN_RECORD_TOOL_NAME}`;
const SCREEN_RECORDING_TOOL_NAME = 'screen_recording';
const SCREEN_RECORDING_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${SCREEN_RECORDING_TOOL_NAME}`;
const SCREEN_RECORD_DESCRIPTION = 'When the owner wants to teach you a task by doing it once, hand your screen to the owner and record the browser. Name the task in a few words. Then stop and wait. When the owner gives the screen back and writes to you, call screen_recording.';
const SCREEN_RECORDING_DESCRIPTION = 'Read the steps the owner did in the last screen recording. Write them as clear steps and save them with skill_add, so the owner can read and fix them on the card. A step that typed a secret must ask for the saved secret.';
const SCREEN_RECORD_SHAPE = {
    task: z.string()
        .trim()
        .min(1)
        .max(MAX_REASON_LENGTH),
};

// Starts the recording and hands the screen over. It throws with a message for the model when it cannot start.
type ScreenRecordHandler = (task: string) => Promise<void>;

function createScreenRecordTool(startRecording: ScreenRecordHandler): CloudbotTool<typeof SCREEN_RECORD_SHAPE> {
    return tool(
        SCREEN_RECORD_TOOL_NAME,
        SCREEN_RECORD_DESCRIPTION,
        SCREEN_RECORD_SHAPE,
        async (args): Promise<ScreenToolResult> => {
            try {
                await startRecording(args.task);

                return textResult('The owner has the screen now and the browser is recorded. Tell the owner to do the task once, then give the screen back and send you a message. Stop and wait.');
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : 'The recording could not start.';

                return textResult(message, true);
            }
        },
    );
}

function createScreenRecordingTool(readRecording: () => string): CloudbotTool<Record<string, never>> {
    return tool(
        SCREEN_RECORDING_TOOL_NAME,
        SCREEN_RECORDING_DESCRIPTION,
        {},
        (): Promise<ScreenToolResult> => {
            const recordingText = readRecording();
            const result = textResult(recordingText);

            return Promise.resolve(result);
        },
    );
}

export {
    MAX_REASON_LENGTH,
    REQUEST_SCREEN_TOOL_FULL_NAME,
    SCREEN_RECORDING_TOOL_FULL_NAME,
    SCREEN_RECORD_TOOL_FULL_NAME,
    SCREEN_SHOW_TOOL_FULL_NAME,
    createRequestScreenTool,
    createScreenRecordTool,
    createScreenRecordingTool,
    createScreenShowTool,
};
export type { ScreenRecordHandler, ScreenRequestHandler, ScreenToolResult };
