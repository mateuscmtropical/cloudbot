import { useEffect, useState } from 'react';

// True only after the flag has stayed true for delayMs. Going false hides it at once, and the timer is cleared on unmount.
function useDelayedFlag(flag: boolean, delayMs: number): boolean {
    const [isDelayed, setDelayed] = useState(false);

    useEffect(() => {
        if (!flag) {
            return undefined;
        }

        const timer = setTimeout(() => {
            setDelayed(true);
        }, delayMs);

        return () => {
            clearTimeout(timer);
            setDelayed(false);
        };
    }, [flag, delayMs]);

    return flag && isDelayed;
}

export { useDelayedFlag };
