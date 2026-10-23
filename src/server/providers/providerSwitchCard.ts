import type { ChoiceBody } from '../../shared/chatTypes.ts';
import { PROVIDER_LABELS } from './providerIds.ts';
import type { ProviderId } from './providerIds.ts';

// The answer that keeps the bot on its provider and lets the usage wait run out.
const KEEP_WAITING_CHOICE_ID = 'wait';

// The card posted after a usage limit. It has one button for each other connected provider, and one to keep waiting.
function buildProviderSwitchCard(current: ProviderId, others: ProviderId[]): ChoiceBody {
    const switchOptions = others.map(provider => ({ id: provider, label: PROVIDER_LABELS[provider] }));

    return {
        kind: 'choice',
        prompt: `${PROVIDER_LABELS[current]} reached its usage limit. Switch to another provider?`,
        options: [...switchOptions, { id: KEEP_WAITING_CHOICE_ID, label: 'Keep waiting' }],
        isProviderSwitch: true,
    };
}

export { KEEP_WAITING_CHOICE_ID, buildProviderSwitchCard };
