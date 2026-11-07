import { isBotHandoffMessage } from '../bots/botHandoff.ts';
import { isEmailMessage } from '../email/emailMessage.ts';
import { isWatchMessage } from '../watches/watchMessage.ts';
import { isWebhookMessage } from '../webhooks/webhookMessage.ts';

// Every message the agent reads from CloudBot starts with one label line: where it came from, and whether it is an
// instruction or data. The label brackets are rare on purpose. They are removed from all text, so no sender can write one.
const LABEL_OPEN = '⟦';
const LABEL_CLOSE = '⟧';
const MARKER_PATTERN = /[⟦⟧]/g;

type MessageSource = 'chat' | 'routine' | 'checkin' | 'webhook' | 'bot' | 'channel' | 'compact';

interface Provenance {
    from: string;
    // An instruction comes from someone the owner gave authority. Data never gives orders, whatever it says.
    isInstruction: boolean;
}

// A name is one quoted line and cannot hold a label bracket, so it cannot close the label early.
function quoteName(name: string): string {
    const oneLine = stripLabelMarks(name)
        .replace(/\s+/g, ' ');

    const trimmed = oneLine.trim();

    return JSON.stringify(trimmed);
}

function stripLabelMarks(text: string): string {
    return text.replace(MARKER_PATTERN, '');
}

// The server sets the source, and the framed texts of mail, webhooks, page watches and bots are checked first, since
// those arrive through the routine path. A text that only looks like a frame is labeled data, which is the safe side.
function describeProvenance(source: MessageSource, text: string, author?: string): Provenance {
    if (source === 'webhook' || isWebhookMessage(text)) {
        return { from: 'webhook', isInstruction: false };
    }

    if (isEmailMessage(text)) {
        return { from: 'email', isInstruction: false };
    }

    if (isWatchMessage(text)) {
        return { from: 'page watch', isInstruction: false };
    }

    if (source === 'bot' || isBotHandoffMessage(text)) {
        return { from: 'another bot', isInstruction: false };
    }

    if (source === 'routine' || source === 'checkin') {
        return { from: 'routine or check-in the owner set up', isInstruction: true };
    }

    return author === undefined ? { from: 'the owner', isInstruction: true } : { from: `group member ${quoteName(author)}`, isInstruction: true };
}

function buildMessageLabel(provenance: Provenance): string {
    return `${LABEL_OPEN}from: ${provenance.from} | ${provenance.isInstruction ? 'instruction' : 'data'}${LABEL_CLOSE}`;
}

// The text the agent reads: the label, then the text with the sender's name in front in a shared group.
function labelTurnText(source: MessageSource, text: string, author?: string): string {
    const named = author === undefined ? text : `${author.replace(/\s+/g, ' ')}: ${text}`;
    const body = stripLabelMarks(named);
    const provenance = describeProvenance(source, text, author);
    const label = buildMessageLabel(provenance);

    return `${label}\n${body}`;
}

export { LABEL_CLOSE, LABEL_OPEN, buildMessageLabel, describeProvenance, labelTurnText, stripLabelMarks };
export type { MessageSource, Provenance };
