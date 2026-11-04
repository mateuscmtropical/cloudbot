import { useEffect, useState } from 'react';

// A mood changes slowly, so the list checks the time only this often.
const MOOD_CLOCK_MS = 5 * 60 * 1000;

// The current time for the moods of the bot list. It updates rarely, so it costs no renders.
function useMoodClock(): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = window.setInterval(() => {
            const currentTime = Date.now();

            setNow(currentTime);
        }, MOOD_CLOCK_MS);

        return () => {
            window.clearInterval(timer);
        };
    }, []);

    return now;
}

export { useMoodClock };
