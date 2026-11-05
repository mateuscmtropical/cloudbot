import type { ProviderModelOptionSummary, WorkKindSummary } from '../../shared/providerTypes.ts';
import { EFFORT_LEVELS, MODEL_ALIASES, isClaudeModel, isEffortLevel } from '../models/modelChoices.ts';
import type { ModelStore } from '../store/ModelStore.ts';
import type { SettingsStore } from '../store/SettingsStore.ts';
import type { ProviderModelCatalogs, ProviderModelOption } from './ProviderModelCatalogs.ts';
import { PROVIDER_LABELS, isProviderId } from './providerIds.ts';
import type { ProviderId } from './providerIds.ts';

const WORK_KINDS = ['search', 'browsing', 'documents', 'routines', 'checkins', 'webhooks', 'review'] as const;

type WorkKind = typeof WORK_KINDS[number];

// What a kind of work runs on now. followsChat means the owner picked no provider for it.
interface WorkChoice {
    provider: ProviderId;
    followsChat: boolean;
    model: string | null;
    effort: string | null;
}

// A null provider makes the work follow the chat.
interface WorkChange {
    provider: ProviderId | null;
    model: string | null;
    effort: string | null;
}

interface StoredWorkChoice {
    provider: ProviderId;
    model: string | null;
    effort: string | null;
}

interface ChatChoice {
    provider: ProviderId;
    model: string | null;
    effort: string | null;
}

interface WorkSettingsOptions {
    settings: Pick<SettingsStore, 'get' | 'set'>;
    modelStore: Pick<ModelStore, 'get' | 'set' | 'getEfforts' | 'setEfforts' | 'getProviderChoice'>;
    modelCatalogs?: ProviderModelCatalogs | undefined;
    providerFor: (botId: string) => Promise<ProviderId>;
    // The providers this server can run.
    available: () => ProviderId[];
    // The providers the owner is signed in to now.
    connected: () => Promise<ProviderId[]>;
}

const WORK_KEY_PREFIX = 'provider.work.';
const DEFAULT_MODEL_KEY_PREFIX = 'provider.defaultModel.';
const WORK_LABELS: Record<WorkKind, string> = {
    search: 'Web search',
    checkins: 'Check-ins',
    webhooks: 'Webhooks',
    routines: 'Routines',
    review: 'Review',
    browsing: 'Browsing',
    documents: 'Documents',
};
// Only these have a one shot review model. The others stay out of the list instead of failing each review.
const REVIEW_PROVIDERS: ProviderId[] = ['claude', 'chatgpt', 'gemini'];
// Claude reports no model list, so the menu offers the aliases its CLI takes, by name.
const CLAUDE_MODELS: ProviderModelOption[] = MODEL_ALIASES.map(id => ({
    id,
    label: `${id.charAt(0)
        .toUpperCase()}${id.slice(1)}`,
    efforts: [...EFFORT_LEVELS],
}));

function workKey(botId: string, kind: WorkKind): string {
    return `${WORK_KEY_PREFIX}${botId}.${kind}`;
}

function readStoredChoice(text: string | undefined): StoredWorkChoice | undefined {
    if (text === undefined || text === '') {
        return undefined;
    }

    try {
        const parsed = JSON.parse(text) as Partial<StoredWorkChoice>;

        return typeof parsed.provider === 'string' && isProviderId(parsed.provider)
            ? { provider: parsed.provider, model: parsed.model ?? null, effort: parsed.effort ?? null }
            : undefined;
    } catch {
        return undefined;
    }
}

function claudeModelOptions(selected: string | null): ProviderModelOption[] {
    const isOffered = selected === null || CLAUDE_MODELS.some(option => option.id === selected);

    // A full model id chosen another way stays in the list, so the menu shows it.
    return isOffered ? CLAUDE_MODELS : [...CLAUDE_MODELS, { id: selected, label: selected, efforts: [...EFFORT_LEVELS] }];
}

// The provider, model and effort of each kind of work. The chat keeps its own provider and model settings.
class WorkSettings {
    private readonly options: WorkSettingsOptions;

    constructor(options: WorkSettingsOptions) {
        this.options = options;
    }

    async read(botId: string, kind: WorkKind): Promise<WorkChoice> {
        return this.readWith(botId, kind, undefined);
    }

    // Returns the problem, or undefined when the change was saved. Nothing is saved when any part is refused.
    async save(botId: string, kind: WorkKind, change: WorkChange): Promise<string | undefined> {
        const { provider, model, effort } = change;

        if (provider !== null && kind === 'review' && !REVIEW_PROVIDERS.includes(provider)) {
            return 'Review runs only on Claude, ChatGPT or Gemini.';
        }

        const problem = await this.checkChoice(botId, change);

        if (problem !== undefined) {
            return problem;
        }

        const usedProvider = provider ?? await this.options.providerFor(botId);

        if (usedProvider === 'claude') {
            const models = await this.options.modelStore.get(botId);
            const efforts = await this.options.modelStore.getEfforts(botId);

            await this.options.modelStore.set(botId, { ...models, [kind]: model });
            await this.options.modelStore.setEfforts(botId, { ...efforts, [kind]: effort as typeof efforts[WorkKind] });
        }

        const key = workKey(botId, kind);
        const storedText = provider === null ? '' : JSON.stringify({ provider, model, effort });

        await this.options.settings.set(key, storedText);

        return undefined;
    }

    // The problem with a change, or undefined when it could be saved. Nothing is saved.
    async checkChoice(botId: string, change: WorkChange): Promise<string | undefined> {
        const { provider, model, effort } = change;
        const available = this.options.available();

        if (provider !== null && !available.includes(provider)) {
            return 'This server does not run that provider.';
        }

        if (provider !== null) {
            const connected = await this.options.connected();

            if (!connected.includes(provider)) {
                return 'Connect that provider first.';
            }
        }

        const usedProvider = provider ?? await this.options.providerFor(botId);

        return usedProvider === 'claude'
            ? this.claudeProblem(model, effort)
            : this.catalogProblem(usedProvider, provider === null ? null : model, provider === null ? null : effort);
    }

    async describe(botId: string): Promise<WorkKindSummary[]> {
        const connected = await this.options.connected();
        const chatProvider = await this.options.providerFor(botId);
        const chat = await this.readChat(botId, chatProvider);
        const summaries = WORK_KINDS.map(kind => this.describeKind(botId, kind, chat, connected));

        return Promise.all(summaries);
    }

    // The real name of the model a provider uses when none is chosen, once the provider reported it.
    async defaultModelName(provider: ProviderId): Promise<string | null> {
        const reported = await this.options.settings.get(`${DEFAULT_MODEL_KEY_PREFIX}${provider}`);

        return this.options.modelCatalogs?.get(provider)?.defaultModel ?? reported ?? null;
    }

    async noteDefaultModel(provider: ProviderId, model: string): Promise<void> {
        await this.options.settings.set(`${DEFAULT_MODEL_KEY_PREFIX}${provider}`, model);
    }

    // The connected providers are read only when the owner picked a provider, so a turn that follows the chat does not wait for them.
    // The caller passes them when it already has them.
    private async readWith(botId: string, kind: WorkKind, connected: ProviderId[] | undefined): Promise<WorkChoice> {
        const stored = await this.storedChoice(botId, kind, connected);
        const chatProvider = await this.options.providerFor(botId);
        const provider = stored?.provider ?? chatProvider;
        const followsChat = stored === undefined;

        if (provider === 'claude') {
            const models = await this.options.modelStore.get(botId);
            const efforts = await this.options.modelStore.getEfforts(botId);
            const model = models[kind];

            return { provider, followsChat, model: model !== null && isClaudeModel(model) ? model : null, effort: efforts[kind] };
        }

        if (stored !== undefined) {
            return { provider, followsChat, model: stored.model, effort: stored.effort };
        }

        // A review should stay quick, so it does not take the model of a chat on another provider.
        if (kind === 'review') {
            return { provider, followsChat, model: null, effort: null };
        }

        const chat = await this.readChat(botId, provider);

        return { provider, followsChat, model: chat.model, effort: chat.effort };
    }

    // The choice the owner saved for a kind. A provider that is no longer connected counts as no choice.
    private async storedChoice(botId: string, kind: WorkKind, connected: ProviderId[] | undefined): Promise<StoredWorkChoice | undefined> {
        const key = workKey(botId, kind);
        const storedText = await this.options.settings.get(key);
        const stored = readStoredChoice(storedText);

        if (stored === undefined) {
            return undefined;
        }

        const connectedNow = connected ?? await this.options.connected();

        return connectedNow.includes(stored.provider) ? stored : undefined;
    }

    private async readChat(botId: string, provider: ProviderId): Promise<ChatChoice> {
        if (provider === 'claude') {
            const models = await this.options.modelStore.get(botId);
            const efforts = await this.options.modelStore.getEfforts(botId);

            return { provider, model: models.chat !== null && isClaudeModel(models.chat) ? models.chat : null, effort: efforts.chat };
        }

        const choice = await this.options.modelStore.getProviderChoice(botId, provider);

        return { provider, model: choice?.model ?? null, effort: choice?.effort ?? null };
    }

    private async describeKind(botId: string, kind: WorkKind, chat: ChatChoice, connected: ProviderId[]): Promise<WorkKindSummary> {
        const choice = await this.readWith(botId, kind, connected);
        const options = choice.provider === 'claude' ? claudeModelOptions(choice.model) : this.options.modelCatalogs?.get(choice.provider)?.models ?? [];
        // With no model of its own, work on the chat's provider runs on the chat's model. A review runs on its own.
        const usesChat = kind !== 'review' && choice.provider === chat.provider;
        const defaultName = await this.defaultModelName(choice.provider);
        const usedModel = choice.model ?? (usesChat ? chat.model : null) ?? defaultName;
        const usedLabel = options.find(option => option.id === usedModel)?.label ?? usedModel;
        const canChooseModel = choice.provider === 'claude' || !choice.followsChat;
        const selectedOption = options.find(option => option.id === (choice.model ?? defaultName));
        const choosable = this.choosableProviders(kind, connected);

        return {
            kind,
            label: WORK_LABELS[kind],
            provider: choice.followsChat ? null : choice.provider,
            usedProvider: choice.provider,
            usedProviderLabel: PROVIDER_LABELS[choice.provider],
            usedModel: usedLabel,
            usedEffort: choice.effort ?? (usesChat && choice.model === null ? chat.effort : null),
            selectedModel: choice.model,
            selectedEffort: choice.effort,
            modelOptions: canChooseModel ? options : [],
            effortOptions: !canChooseModel ? [] : selectedOption?.efforts ?? (choice.provider === 'claude' ? [...EFFORT_LEVELS] : []),
            allowedProviders: kind === 'review' ? REVIEW_PROVIDERS : null,
            choosableProviders: choosable,
            providerModels: this.providerModelsOf(choosable),
        };
    }

    // The providers the owner may pick for a kind: available and signed in, and for a review only one that reviews.
    private choosableProviders(kind: WorkKind, connected: ProviderId[]): ProviderId[] {
        const available = this.options.available();

        return available.filter(provider => connected.includes(provider) && (kind !== 'review' || REVIEW_PROVIDERS.includes(provider)));
    }

    // The model options each of these providers offers, keyed by provider id.
    private providerModelsOf(providers: ProviderId[]): Record<string, ProviderModelOptionSummary[]> {
        const entries = providers.map(provider => [provider, this.modelOptionsOf(provider)] as const);

        return Object.fromEntries(entries);
    }

    // Claude reports no model list, so it offers its aliases. Another provider offers the models it reported.
    private modelOptionsOf(provider: ProviderId): ProviderModelOption[] {
        return provider === 'claude' ? claudeModelOptions(null) : (this.options.modelCatalogs?.get(provider)?.models ?? []);
    }

    private claudeProblem(model: string | null, effort: string | null): string | undefined {
        if (model !== null && !isClaudeModel(model)) {
            return 'Choose a Claude model.';
        }

        return effort !== null && !isEffortLevel(effort) ? 'Choose an effort Claude offers.' : undefined;
    }

    private catalogProblem(provider: ProviderId, model: string | null, effort: string | null): string | undefined {
        const catalog = this.options.modelCatalogs?.get(provider);
        const option = catalog?.models.find(candidate => candidate.id === (model ?? catalog.defaultModel));

        if (model !== null && (catalog === undefined || !catalog.models.some(candidate => candidate.id === model))) {
            const ids = catalog?.models.map(candidate => candidate.id) ?? [];

            return ids.length === 0
                ? 'That provider has reported no models yet. Leave the model empty to use its default.'
                : `Choose one of the models of that provider: ${ids.join(', ')}.`;
        }

        return effort !== null && option?.efforts.includes(effort) !== true ? 'Choose an effort offered for that model.' : undefined;
    }
}

export { CLAUDE_MODELS, REVIEW_PROVIDERS, WORK_KINDS, WorkSettings, claudeModelOptions };
export type { WorkChange, WorkChoice, WorkKind, WorkSettingsOptions };
