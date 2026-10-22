import type { RoutineRecord } from '../store/RoutineStore.ts';

// The reply of a check-in that found nothing for the owner. ChatService drops the whole run when the last text is this.
const QUIET_REPLY = 'NOTHING_TO_REPORT';

const QUIET_REPLY_PATTERN = new RegExp(`^\`?${QUIET_REPLY}\`?\\.?$`);

// The model for a check-in that has no routines model. Check-ins run often, so the default is the cheapest one.
const CHECKIN_DEFAULT_MODEL = 'haiku';

function buildCheckinMessage(routine: RoutineRecord): string {
    return `Check-in "${routine.name}": ${routine.prompt}\n\nMessage the owner only if something needs them. If nothing does, reply with exactly ${QUIET_REPLY} and nothing else.`;
}

function isQuietReply(text: string): boolean {
    const trimmedText = text.trim();

    return QUIET_REPLY_PATTERN.test(trimmedText);
}

export { CHECKIN_DEFAULT_MODEL, QUIET_REPLY, buildCheckinMessage, isQuietReply };
