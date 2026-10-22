import type { SettingsStore } from '../store/SettingsStore.ts';
import { isProviderId } from './providerIds.ts';
import type { ProviderId } from './providerIds.ts';

const DEFAULT_KEY = 'provider.default';
const BOT_KEY_PREFIX = 'provider.bot.';

// Which provider each bot runs on. A bot with no choice uses the default, which is the provider the owner connected last.
class ProviderChoices {
    private readonly settings: Pick<SettingsStore, 'get' | 'set'>;

    constructor(settings: Pick<SettingsStore, 'get' | 'set'>) {
        this.settings = settings;
    }

    async getDefault(): Promise<ProviderId> {
        const stored = await this.settings.get(DEFAULT_KEY);

        return stored !== undefined && isProviderId(stored) ? stored : 'claude';
    }

    async setDefault(provider: ProviderId): Promise<void> {
        await this.settings.set(DEFAULT_KEY, provider);
    }

    async forBot(botId: string): Promise<ProviderId> {
        const stored = await this.settings.get(BOT_KEY_PREFIX + botId);

        return stored !== undefined && isProviderId(stored) ? stored : this.getDefault();
    }

    async setForBot(botId: string, provider: ProviderId): Promise<void> {
        await this.settings.set(BOT_KEY_PREFIX + botId, provider);
    }
}

export { ProviderChoices };
