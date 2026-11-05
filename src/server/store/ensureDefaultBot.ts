import type { MascotChoice } from '../../shared/mascot.ts';
import type { BotStore } from './BotStore.ts';
import type { BotProfile } from './types.ts';

const DEFAULT_BOT_PROFILE: BotProfile = {
    name: 'CloudBot',
    title: 'Your coworker',
    description: '',
};
// The first bot wears the blue of the project, not a random cloud.
const DEFAULT_BOT_MASCOT: MascotChoice = { color: 'blue', shape: 'puff', eyes: 'smile' };

// Creates the default bot on the first start, so the web app never opens on an empty list.
async function ensureDefaultBot(botStore: BotStore): Promise<void> {
    const existingBots = await botStore.list();

    if (existingBots.length > 0) {
        return;
    }

    await botStore.create(DEFAULT_BOT_PROFILE, DEFAULT_BOT_MASCOT);
}

export { ensureDefaultBot };
