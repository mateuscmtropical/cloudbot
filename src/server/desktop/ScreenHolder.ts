type ScreenHolderName = 'bot' | 'person';

// The desktop is shared by all bots, so one state says who may act on it.
// The state lives in memory. After a restart the bot holds the screen again.
class ScreenHolder {
    private current: ScreenHolderName = 'bot';

    get holder(): ScreenHolderName {
        return this.current;
    }

    get isPersonHolding(): boolean {
        return this.current === 'person';
    }

    giveToPerson(): void {
        this.current = 'person';
    }

    giveToBot(): void {
        this.current = 'bot';
    }
}

const SCREEN_HELD_BY_PERSON_MESSAGE = 'The owner has the screen right now. Do not use the browser. Stop and wait until the owner tells you to continue.';

export { SCREEN_HELD_BY_PERSON_MESSAGE, ScreenHolder };
export type { ScreenHolderName };
