import type { MascotState } from './mascotState.ts';

// A mood plays while a bot has nothing to do. It never replaces a state, which says something real about the bot.
type MascotMood = 'dozing' | 'sleeping' | 'cold';

// The drawn effect around a mascot. A state brings its own, and an idle bot shows the one of its mood.
type MascotEffect = MascotMood | 'storm' | 'question' | 'cheer';

interface MascotMoodInput {
    botId: string;
    lastActivityAt: number | undefined;
    // The open bot is awake, since the owner is looking at it.
    isSelected: boolean;
    now: number;
    // When the owner left this chat. It stays awake for a moment after that.
    leftAt?: number | undefined;
}

// A chat quiet for this long falls asleep.
const SLEEP_AFTER_MS = 60 * 60 * 1000;
// A chat the owner just left stays awake this long, however old its last message is.
const AWAKE_AFTER_LEAVING_MS = 60 * 1000;
// The length of the nod before sleep. The animation in the stylesheet takes the same time.
const DOZE_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
// One bot in this many has a cold on a given day.
const COLD_ONE_IN = 5;
// The length of the sneeze cycle in the stylesheet, so each bot can start at its own point in it.
const SNEEZE_CYCLE_S = 14;

// A small stable number for a bot, so its mood and its timing do not change between renders.
function readBotSeed(botId: string): number {
    return Array.from(botId)
        .reduce((total, character) => total + (character.codePointAt(0) ?? 0), 0);
}

// The moment a closed chat is asleep. A chat with no activity and not just left is asleep already.
function readSleepAt(input: MascotMoodInput): number {
    const quietAt = (input.lastActivityAt ?? Number.NEGATIVE_INFINITY) + SLEEP_AFTER_MS;
    const settledAt = (input.leftAt ?? Number.NEGATIVE_INFINITY) + AWAKE_AFTER_LEAVING_MS;

    return Math.max(quietAt, settledAt);
}

function pickMascotMood(input: MascotMoodInput): MascotMood | undefined {
    const seed = readBotSeed(input.botId);
    const day = Math.floor(input.now / DAY_MS);
    const hasCold = (seed + day) % COLD_ONE_IN === 0;
    const sleepAt = readSleepAt(input);

    if (!input.isSelected && input.now >= sleepAt) {
        return 'sleeping';
    }

    if (!input.isSelected && input.now >= sleepAt - DOZE_MS) {
        return 'dozing';
    }

    return hasCold ? 'cold' : undefined;
}

// The next moment the mood can change, so a timer can wait for exactly that. A new day can change who has a cold.
function readNextMoodChangeAt(input: MascotMoodInput): number {
    const nextDayAt = (Math.floor(input.now / DAY_MS) + 1) * DAY_MS;
    const sleepAt = readSleepAt(input);
    const steps = input.isSelected ? [] : [sleepAt - DOZE_MS, sleepAt];
    const laterSteps = steps.filter(step => step > input.now);

    return Math.min(nextDayAt, ...laterSteps);
}

function pickMascotEffect(state: MascotState, mood: MascotMood | undefined): MascotEffect | undefined {
    switch (state) {
        case 'idle':
            return mood;
        case 'sleepy':
            return 'sleeping';
        case 'error':
            return 'storm';
        case 'waiting':
            return 'question';
        case 'done':
            return 'cheer';
        case 'typing':
        case 'thinking':
        case 'working':
            return undefined;
    }
}

// A negative delay, so bots with a cold do not all sneeze at once.
function readSneezeDelaySeconds(botId: string): number {
    return -(readBotSeed(botId) % SNEEZE_CYCLE_S);
}

export { pickMascotEffect, pickMascotMood, readNextMoodChangeAt, readSneezeDelaySeconds };
export type { MascotEffect, MascotMood, MascotMoodInput };
