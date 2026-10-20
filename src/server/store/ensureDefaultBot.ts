import type { BotStore } from './BotStore.ts';
import type { BotProfile } from './types.ts';

const DEFAULT_BOT_PROFILE: BotProfile = {
    name: 'CloudBot',
    title: 'Your coworker',
    description: '',
};

// Creates the default bot on the first start, so the web app never opens on an empty list.
async function ensureDefaultBot(botStore: BotStore): Promise<void> {
    const existingBots = await botStore.list();

    if (existingBots.length > 0) {
        return;
    }

    await botStore.create(DEFAULT_BOT_PROFILE);
}

export { ensureDefaultBot };
