// Thrown when a message, upload or webhook call reaches a bot that is being deleted. The routes answer 409 with it.
class BotDeletingError extends Error {
    constructor() {
        super('This bot is being deleted.');
        this.name = 'BotDeletingError';
    }
}

export { BotDeletingError };
