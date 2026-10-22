import type { TurnLimit, TurnLimits } from '../../shared/limitTypes.ts';

type LimitKind = 'minutes' | 'usd' | 'steps';

type LimitSlot = 'chat' | 'routines';

// The limit that stopped a turn, with the value the owner set. The chat message names both.
interface TurnLimitStop {
    kind: LimitKind;
    value: number;
}

interface LimitInputError {
    error: string;
}

interface LimitRule {
    min: number;
    max: number;
    isWhole: boolean;
}

const LIMIT_KINDS: LimitKind[] = ['minutes', 'usd', 'steps'];
const LIMIT_SLOTS: LimitSlot[] = ['chat', 'routines'];
const LIMIT_RULES: Record<LimitKind, LimitRule> = {
    minutes: { min: 1, max: 1440, isWhole: true },
    usd: { min: 0.01, max: 1000, isWhole: false },
    steps: { min: 1, max: 1000, isWhole: true },
};
const NO_LIMIT: TurnLimit = { minutes: null, usd: null, steps: null };
const NO_LIMITS: TurnLimits = { chat: NO_LIMIT, routines: NO_LIMIT };
const INVALID_BODY: LimitInputError = { error: 'Send an object with the chat and routines limits.' };

function describeRule(kind: LimitKind): string {
    const rule = LIMIT_RULES[kind];
    const whole = rule.isWhole ? 'a whole number' : 'a number';

    return `${whole} from ${String(rule.min)} to ${String(rule.max)}`;
}

function isValidLimitValue(value: unknown, kind: LimitKind): boolean {
    if (value === undefined || value === null) {
        return true;
    }

    const rule = LIMIT_RULES[kind];

    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return false;
    }

    const isWholeOk = !rule.isWhole || Number.isInteger(value);

    return isWholeOk && value >= rule.min && value <= rule.max;
}

function toLimitValue(value: unknown): number | null {
    return typeof value === 'number' ? value : null;
}

// One slot of the nested shape: { minutes, usd, steps }. A missing slot or field means no limit.
function parseSlot(value: unknown, slot: LimitSlot): TurnLimit | LimitInputError {
    if (value === undefined) {
        return { ...NO_LIMIT };
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { error: `${slot} must be an object with minutes, usd and steps.` };
    }

    const fields = value as Record<string, unknown>;
    const unknownKey = Object.keys(fields)
        .find(key => !LIMIT_KINDS.some(kind => kind === key));

    if (unknownKey !== undefined) {
        return { error: `${slot}.${unknownKey} is not a limit. Use minutes, usd or steps.` };
    }

    const invalidKind = LIMIT_KINDS.find(kind => !isValidLimitValue(fields[kind], kind));

    if (invalidKind !== undefined) {
        return { error: `${slot}.${invalidKind} must be ${describeRule(invalidKind)}, or null for no limit.` };
    }

    return { minutes: toLimitValue(fields.minutes), usd: toLimitValue(fields.usd), steps: toLimitValue(fields.steps) };
}

// The one validation path. The web route and the limits_set tool both pass the nested shape here.
function parseLimitInput(payload: unknown): TurnLimits | LimitInputError {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return INVALID_BODY;
    }

    const fields = payload as Record<string, unknown>;
    const unknownSlot = Object.keys(fields)
        .find(key => !LIMIT_SLOTS.some(slot => slot === key));

    if (unknownSlot !== undefined) {
        return { error: `${unknownSlot} is not a limit. Use chat or routines.` };
    }

    const chat = parseSlot(fields.chat, 'chat');

    if (isLimitInputError(chat)) {
        return chat;
    }

    const routines = parseSlot(fields.routines, 'routines');

    if (isLimitInputError(routines)) {
        return routines;
    }

    return { chat, routines };
}

function isLimitInputError(value: unknown): value is LimitInputError {
    return typeof value === 'object' && value !== null && 'error' in value;
}

// Chat turns use the chat limits. Every other turn uses the routines limits.
function chooseTurnLimit(limits: TurnLimits, source: 'chat' | 'routine' | 'checkin' | 'webhook' | 'bot'): TurnLimit {
    return source === 'chat' ? limits.chat : limits.routines;
}

function describeLimitValue(kind: LimitKind, value: number): string {
    switch (kind) {
        case 'minutes':
            return `the time limit of ${String(value)} ${value === 1 ? 'minute' : 'minutes'}`;
        case 'usd':
            return `the spending limit of $${String(value)}`;
        case 'steps':
            return `the step limit of ${String(value)} steps`;
    }
}

// The message the owner reads when a limit stops a turn. It names the limit and its value, so the owner can raise it.
function describeLimitStop(stop: TurnLimitStop): string {
    const limitText = describeLimitValue(stop.kind, stop.value);

    return `The turn stopped at ${limitText}. Raise it in the Limits section of the Models panel, or ask me to change it.`;
}

function describeLimits(limits: TurnLimits): string {
    const chatText = describeLimitSet(limits.chat);
    const routineText = describeLimitSet(limits.routines);

    return `chat ${chatText}, routines ${routineText}`;
}

function describeLimitSet(limit: TurnLimit): string {
    const parts = [
        limit.minutes === null ? 'no time limit' : `${String(limit.minutes)} minutes`,
        limit.usd === null ? 'no spending limit' : `$${String(limit.usd)}`,
        limit.steps === null ? 'no step limit' : `${String(limit.steps)} steps`,
    ];

    return parts.join(', ');
}

export { LIMIT_RULES, NO_LIMIT, NO_LIMITS, chooseTurnLimit, describeLimitStop, describeLimits, isLimitInputError, parseLimitInput };
export type { LimitInputError, LimitKind, LimitSlot, TurnLimitStop };
