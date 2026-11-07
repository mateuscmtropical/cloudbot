import { OUTSIDE_DATA_LINE } from '../webhooks/webhookMessage.ts';
import type { TriggerEvent } from './triggerSources.ts';

// The first line of every app event message. The review context reads it to label the events as outside data.
const TRIGGER_MESSAGE_PREFIX = 'App event ';
const MAX_SHOWN_EVENTS = 10;

// The owner's instruction is on the first line, above the outside data mark, so nothing an app sends can sit there.
// The events come from the app, so they stay below the mark.
function buildTriggerMessage(name: string, sourceLabel: string, prompt: string, events: TriggerEvent[]): string {
    const shown = events.slice(0, MAX_SHOWN_EVENTS)
        .map(event => `- ${event.text}`);
    const hiddenCount = events.length - shown.length;
    const hiddenLines = hiddenCount > 0 ? [`... and ${String(hiddenCount)} more new items.`] : [];

    return [
        `${TRIGGER_MESSAGE_PREFIX}"${name}" (${sourceLabel}) has ${String(events.length)} new. The owner's instruction for it: ${prompt}`,
        OUTSIDE_DATA_LINE,
        '',
        ...shown,
        ...hiddenLines,
    ].join('\n');
}

// Both lines must match, so an owner message that only starts with the prefix is not taken for an app event.
function isTriggerMessage(text: string): boolean {
    const [firstLine, secondLine] = text.split('\n');

    return firstLine?.startsWith(TRIGGER_MESSAGE_PREFIX) === true && secondLine === OUTSIDE_DATA_LINE;
}

export { TRIGGER_MESSAGE_PREFIX, buildTriggerMessage, isTriggerMessage };
