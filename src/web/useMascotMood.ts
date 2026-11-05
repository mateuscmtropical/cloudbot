import { useEffect, useLayoutEffect, useState } from 'react';

import type { MascotWeather } from '../shared/mascot.ts';
import { pickMascotMood, readNextMoodChangeAt } from './mascotMood.ts';
import type { MascotMood } from './mascotMood.ts';

interface MascotMoodOwner {
    botId: string;
    lastActivityAt: number | undefined;
    isSelected: boolean;
    weather: MascotWeather;
}

// The mood of a bot in the list. One timer waits for its next change, so a mascot costs no render until then.
function useMascotMood({ botId, lastActivityAt, isSelected, weather }: MascotMoodOwner): MascotMood | undefined {
    const [now, setNow] = useState(() => Date.now());
    const [leftAt, setLeftAt] = useState<number | undefined>(undefined);
    const input = { botId, lastActivityAt, isSelected, now, leftAt, weather };
    const nextChangeAt = readNextMoodChangeAt(input);

    // Runs before the paint, so a chat the owner just left never shows one frame of sleep.
    useLayoutEffect(() => {
        if (!isSelected) {
            return undefined;
        }

        return () => {
            const currentTime = Date.now();

            setLeftAt(currentTime);
            setNow(currentTime);
        };
    }, [isSelected]);

    useEffect(() => {
        const waitMs = nextChangeAt - Date.now();
        const timer = window.setTimeout(() => {
            const currentTime = Date.now();

            setNow(currentTime);
        }, waitMs);

        return () => {
            window.clearTimeout(timer);
        };
    }, [nextChangeAt]);

    return pickMascotMood(input);
}

export { useMascotMood };
