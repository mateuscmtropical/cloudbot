import type { ChatMessage } from '../shared/chatTypes.ts';

// The faces a mascot can show. Idle is the calm face. The others follow what the bot is doing.
type MascotState = 'idle' | 'typing' | 'thinking' | 'done' | 'waiting' | 'sleepy' | 'error';

interface MascotStateInput {
    // A turn of this bot is running or streaming.
    isRunning: boolean;
    // The owner has text in the composer.
    isOwnerTyping: boolean;
    // A turn of this bot ended a moment ago. The app clears this after a short time.
    isJustFinished: boolean;
    // The messages of this bot, oldest first.
    messages: ChatMessage[];
}

// The texts the server writes for each failure, copied from ChatService, StallWatchdog, turnLimits and SdkAgentRunner.
// Any other system note is not a failure, so it leaves the face idle.
// A usage limit wait, shown as sleepy.
const USAGE_LIMIT_TEXT_PATTERN = /^The usage limit was reached\./;
// A limit stop, such as "The turn stopped at the time limit of 5 minutes. Raise it in the Limits section ...".
const LIMIT_STOP_TEXT_PATTERN = /^The turn stopped at the (time limit|spending limit|step limit) of /;
const STALL_STOP_TEXT = 'The turn stopped because it sent nothing for 10 minutes.';
// The fixed texts of a turn error. Other turn errors carry the text of the SDK, which is not fixed, so they stay idle.
const TURN_ERROR_TEXTS = new Set([
    'The turn ended with an error.',
    'Could not prepare the agent workspace. Please try again.',
]);

function isErrorNoteText(text: string): boolean {
    return LIMIT_STOP_TEXT_PATTERN.test(text) || text === STALL_STOP_TEXT || TURN_ERROR_TEXTS.has(text);
}

function lastIndexWhere(messages: ChatMessage[], test: (message: ChatMessage) => boolean): number {
    return messages.reduce((found, message, index) => (test(message) ? index : found), -1);
}

// A question that holds a tool call until the owner answers, and has no answer yet.
function isPendingApproval(message: ChatMessage): boolean {
    return message.body.kind === 'choice' && message.body.isApproval === true && message.body.chosenId === undefined;
}

// The state a failed turn left behind: a known note after the owner's last message, with no answer after it.
// A usage limit note means a wait. A known error note means an error. Any other note leaves no failure.
function findFailureState(messages: ChatMessage[]): 'sleepy' | 'error' | undefined {
    const lastUserIndex = lastIndexWhere(messages, message => message.role === 'user');
    const lastNoteIndex = lastIndexWhere(messages, message => message.role === 'system');
    const lastAnswerIndex = lastIndexWhere(messages, message => message.role === 'assistant');

    if (lastNoteIndex <= lastUserIndex || lastNoteIndex < lastAnswerIndex) {
        return undefined;
    }

    const note = messages[lastNoteIndex];

    if (note === undefined || note.body.kind !== 'text') {
        return undefined;
    }

    if (USAGE_LIMIT_TEXT_PATTERN.test(note.body.text)) {
        return 'sleepy';
    }

    return isErrorNoteText(note.body.text) ? 'error' : undefined;
}

// The face of the live bot. The first rule that holds wins: waiting on the owner, then a running turn,
// then the owner typing, then a turn that just finished, then a failure, then idle.
function deriveMascotState(input: MascotStateInput): MascotState {
    if (input.messages.some(isPendingApproval)) {
        return 'waiting';
    }

    if (input.isRunning) {
        return 'thinking';
    }

    if (input.isOwnerTyping) {
        return 'typing';
    }

    const failureState = findFailureState(input.messages);

    if (input.isJustFinished && failureState === undefined) {
        return 'done';
    }

    return failureState ?? 'idle';
}

export { deriveMascotState };
export type { MascotState, MascotStateInput };
