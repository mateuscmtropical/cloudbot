type ScreenHolderName = 'bot' | 'person';

// The desktop is shared by all bots, so one state says who may act on it.
// The state lives in memory. After a restart the bot holds the screen again.
class ScreenHolder {
    private current: ScreenHolderName = 'bot';
    private readonly listeners = new Set<(isPersonHolding: boolean) => void>();

    get holder(): ScreenHolderName {
        return this.current;
    }

    get isPersonHolding(): boolean {
        return this.current === 'person';
    }

    giveToPerson(): void {
        this.setHolder('person');
    }

    giveToBot(): void {
        this.setHolder('bot');
    }

    // Called each time the holder changes. Returns the function that stops the calls.
    onChange(listener: (isPersonHolding: boolean) => void): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    private setHolder(holder: ScreenHolderName): void {
        const isChanged = this.current !== holder;

        this.current = holder;

        if (isChanged) {
            const isPersonHolding = holder === 'person';

            this.listeners.forEach((listener) => {
                listener(isPersonHolding);
            });
        }
    }
}

const SCREEN_HELD_BY_PERSON_MESSAGE = 'The owner has the screen right now. Do not use the browser. Stop and wait until the owner tells you to continue.';

export { SCREEN_HELD_BY_PERSON_MESSAGE, ScreenHolder };
export type { ScreenHolderName };
