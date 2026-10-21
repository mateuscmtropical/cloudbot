// The limits of one kind of turn. A null field means no limit of that kind.
interface TurnLimit {
    // Minutes of work per turn. The clock holds while the turn waits on the owner.
    minutes: number | null;
    // Estimated US dollars per turn, review agent included.
    usd: number | null;
    // Agent steps per turn.
    steps: number | null;
}

// Chat turns use the chat limits. Routine, webhook and watch turns use the routines limits.
interface TurnLimits {
    chat: TurnLimit;
    routines: TurnLimit;
}

export type { TurnLimit, TurnLimits };
