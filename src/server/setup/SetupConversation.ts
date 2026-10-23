import type { ChatMessage, MessageBody } from '../../shared/chatTypes.ts';
import type { ChatService } from '../chat/ChatService.ts';
import type { ClaudeAuthStatus } from '../claudeAuth/getClaudeAuthStatus.ts';
import type { ClaudeLoginSession } from '../claudeAuth/startClaudeLogin.ts';
import type { MessageStore } from '../store/MessageStore.ts';
import type { SettingsStore } from '../store/SettingsStore.ts';
import type { ProviderId } from '../providers/providerIds.ts';
import type { Vault } from '../vault/Vault.ts';

// The two ways to connect Claude. Other providers sign in by a link, see ProviderSignIn.
type SetupMode = 'subscription' | 'apiKey';
type SetupAction = 'choice' | 'code' | 'secret';

interface SetupState {
    step: 'choice' | 'login' | 'code' | 'secret' | 'device' | 'done';
    // The Claude way being set up now.
    mode?: SetupMode;
    messageId?: string;
    linkMessageId?: string;
    // True once any provider is connected. The chats stay open while the owner connects another one.
    ready?: boolean;
    // The Claude way that is connected, kept while another provider signs in.
    claudeMode?: SetupMode;
    // The provider that signs in by link now.
    signIn?: string;
    // The provider whose API key the secret form asks for. Unset for the Claude key.
    keyFor?: string;
    // The provider account variant whose API key the form asks for.
    keyMethod?: ProviderMethod;
}

interface DeviceSignInLink {
    url: string;
    // The code the owner types on the provider's page. The message that shows it is replaced when the sign-in ends.
    code?: string | undefined;
    // True when the provider's page shows a code that the owner pastes back, like the Google sign-in of Gemini.
    needsCode?: boolean | undefined;
}

type DeviceSignInResult = { ok: true } | { ok: false; reason: string };

interface DeviceSignInSession {
    link: Promise<DeviceSignInLink | null>;
    finished: Promise<DeviceSignInResult>;
    cancel: () => void;
    // Passes the code the owner pasted to the CLI. It is never stored.
    submitCode?: ((code: string) => void) | undefined;
}

// A provider that signs in on its own page, like ChatGPT with a device code.
interface ProviderSignIn {
    id: Exclude<ProviderId, 'claude'>;
    label: string;
    // The name of the page the owner signs in on, such as OpenAI.
    site: string;
    start: () => DeviceSignInSession;
    // Undefined when the status could not be read.
    isSignedIn: () => Promise<boolean | undefined>;
    // The text of the choice. It defaults to the label and the word subscription.
    optionLabel?: string | undefined;
    // True when the sign-in ends at once without a link, so the choice opens no browser tab.
    isFree?: boolean | undefined;
}

// A provider that takes an API key. The key goes to the vault, and a local proxy adds it to each request.
interface ProviderApiKey {
    id: Exclude<ProviderId, 'claude'>;
    label: string;
    // The name of the page the key comes from, such as Google AI Studio.
    site: string;
    secretName: string;
    // Answers with the HTTP status of a cheap call made with the key.
    checkKey: (key: string) => Promise<number>;
    // Some providers use different API routes for accounts under the same provider card.
    variants?: ProviderApiKeyVariant[] | undefined;
}

interface ProviderApiKeyVariant {
    method: ProviderMethod;
    label: string;
    site: string;
    checkKey: (key: string) => Promise<number>;
}

interface ConnectedProvider {
    id: Exclude<ProviderId, 'claude'>;
    label: string;
}

type ProviderMethod = 'signIn' | 'apiKey' | 'apiKeyZen' | 'apiKeyGo';

interface ProviderOption {
    id: string;
    label: string;
    opensLink?: boolean;
}

interface SetupConversationOptions {
    botId: string;
    chat: ChatService;
    messages: MessageStore;
    settings: SettingsStore;
    vault: Pick<Vault, 'has' | 'set' | 'delete'>;
    startLogin: () => ClaudeLoginSession;
    authStatus: () => Promise<ClaudeAuthStatus>;
    // Called when Claude or another provider is connected, with the way another provider was connected.
    connect: (connection: SetupMode | ProviderId, method?: ProviderMethod) => Promise<void>;
    // Called when the owner connects a provider in this chat, so the bot of the chat runs on it from the next message.
    useProvider?: ((provider: ProviderId) => Promise<void>) | undefined;
    // The providers that sign in by link. Each one is a choice next to the two Claude ways.
    signIns?: ProviderSignIn[] | undefined;
    // The providers that take an API key. Each one is a choice too.
    apiKeys?: ProviderApiKey[] | undefined;
    checkKey: (key: string) => Promise<number>;
    // Runs the CLI's own logout for CloudBot's login only.
    signOut?: () => Promise<void>;
    // True when no agent user is set, so the bot runs as the owner's account.
    localMode: boolean;
    // Why the bot has no browser on this computer. The setup says so once.
    noBrowser?: 'notInstalled' | 'leftover' | undefined;
}

const SETUP_STATE_KEY = 'claude.setup';
const KEY_CHOICE_PREFIX = 'key:';
const PROVIDER_CHOICE_PREFIX = 'provider:';
const API_KEY_NAME = 'ANTHROPIC_API_KEY';
const LOCAL_MODE_LINE = 'Local mode: I run as you, on this computer, with your files and your account.';
const NO_BROWSER_LINE = 'This computer has no browser for me, so I cannot browse. Install Chrome, Chromium or Edge to give me one.';
const LEFTOVER_BROWSER_LINE = 'A browser from my last run is still open on this computer, so I cannot browse. Close that CloudBot browser window, then restart CloudBot.';
const LOGIN_FAILURES = {
    timeout: 'Sign-in timed out.',
    cliMissing: 'The Claude CLI is missing.',
    exitedWithError: 'Claude sign-in failed.',
    cancelled: 'Sign-in was cancelled.',
};

class SetupAnswerError extends Error {}

class SetupConversation {
    private readonly options: SetupConversationOptions;
    private state: SetupState = { step: 'choice' };
    private session: ClaudeLoginSession | undefined;
    private deviceSession: DeviceSignInSession | undefined;
    private starting = true;
    // Settles when the current start ends, so a message sent during the start can wait for it.
    private started = Promise.withResolvers<undefined>();
    private closed = false;
    private pending: Promise<unknown> = Promise.resolve();

    constructor(options: SetupConversationOptions) {
        this.options = options;
    }

    isDone(): boolean {
        return !this.starting && !this.closed && (this.state.step === 'done' || this.state.ready === true);
    }

    // What stays when the setup moves to another step.
    private kept(): Pick<SetupState, 'ready' | 'claudeMode'> {
        return {
            ...(this.state.ready === true ? { ready: true } : {}),
            ...(this.state.claudeMode === undefined ? {} : { claudeMode: this.state.claudeMode }),
        };
    }

    private signInById(id: string): ProviderSignIn | undefined {
        const signIns = this.options.signIns ?? [];

        return signIns.find(signIn => signIn.id === id);
    }

    private apiKeyById(id: string): ProviderApiKey | undefined {
        const apiKeys = this.options.apiKeys ?? [];

        return apiKeys.find(apiKey => apiKey.id === id);
    }

    // The provider of a choice such as key:gemini.
    private apiKeyByChoice(choice: string | undefined): ProviderApiKey | undefined {
        if (choice?.startsWith(KEY_CHOICE_PREFIX) !== true) {
            return undefined;
        }

        const id = choice.slice(KEY_CHOICE_PREFIX.length)
            .split(':')[0];

        return id === undefined ? undefined : this.apiKeyById(id);
    }

    private apiKeyVariantByChoice(choice: string | undefined): ProviderApiKeyVariant | undefined {
        if (choice?.startsWith(KEY_CHOICE_PREFIX) !== true) {
            return undefined;
        }

        const [id, method] = choice.slice(KEY_CHOICE_PREFIX.length)
            .split(':');
        const apiKey = id === undefined ? undefined : this.apiKeyById(id);

        return apiKey?.variants?.find(variant => variant.method === method);
    }

    private apiKeyVariantByMethod(apiKey: ProviderApiKey | undefined, method: ProviderMethod | undefined): ProviderApiKeyVariant | undefined {
        return method === undefined ? undefined : apiKey?.variants?.find(variant => variant.method === method);
    }

    // A provider counts as connected with its sign-in or with its key in the vault.
    private async signedInIds(): Promise<ProviderId[]> {
        const signIns = this.options.signIns ?? [];
        const checks = signIns.map(signIn => signIn.isSignedIn()
            .catch(() => undefined));
        const statuses = await Promise.all(checks);
        const signedIn = signIns.filter((_signIn, index) => statuses[index] === true)
            .map(signIn => signIn.id);
        const apiKeys = this.options.apiKeys ?? [];
        const withKey = apiKeys.filter(apiKey => this.options.vault.has(apiKey.secretName) && !signedIn.includes(apiKey.id))
            .map(apiKey => apiKey.id);

        return [...signedIn, ...withKey];
    }

    // The first provider that is signed in, in the order of the list. The checks run together and the wait ends at the first hit, so a slow provider further down does not hold the start.
    private async firstSignedInId(): Promise<ProviderId | undefined> {
        const signIns = this.options.signIns ?? [];
        const checks = signIns.map(signIn => signIn.isSignedIn()
            .catch(() => undefined));
        const noneYet = Promise.resolve<ProviderId | undefined>(undefined);
        const firstSignedIn = await checks.reduce(async (found, check, index) => {
            const earlier = await found;

            return earlier ?? (await check === true ? signIns[index]?.id : undefined);
        }, noneYet);

        if (firstSignedIn !== undefined) {
            return firstSignedIn;
        }

        const apiKeys = this.options.apiKeys ?? [];

        return apiKeys.find(apiKey => this.options.vault.has(apiKey.secretName))?.id;
    }

    private connectedById(id: ProviderId): ConnectedProvider | undefined {
        const found = this.signInById(id) ?? this.apiKeyById(id);

        return found === undefined ? undefined : { id: found.id, label: found.label };
    }

    // Read from the saved state, so a turn does not run the CLI status check.
    isClaudeConnected(): boolean {
        return this.state.claudeMode !== undefined || (this.state.step === 'done' && this.state.mode !== undefined);
    }

    // The providers that are signed in now, for the bot's provider tools.
    async connectedProviders(): Promise<ProviderId[]> {
        const claude = await this.isConnected(this.state.claudeMode);
        const signedIn = await this.signedInIds();

        return claude === true ? ['claude', ...signedIn] : signedIn;
    }

    // Posts the provider list in the setup chat, so the owner can connect another provider.
    offerProviders(): Promise<void> {
        return this.serial(async () => {
            if (this.closed) {
                return;
            }

            if (this.state.ready !== true) {
                await this.askMode();

                return;
            }

            this.cancelSessions();
            await this.retireActive();
            this.state = { ...this.kept(), step: 'done' };
            await this.ask({ kind: 'choice', prompt: 'Which AI provider would you like to connect?', options: this.providerOptions() });
        });
    }

    // One choice per provider. The way to use it, subscription or API key, is asked next.
    private providerOptions(): ProviderOption[] {
        const signIns = this.options.signIns ?? [];
        const apiKeys = this.options.apiKeys ?? [];
        const ids = [...new Set([...signIns.map(signIn => signIn.id), ...apiKeys.map(apiKey => apiKey.id)])];
        const otherOptions = ids.map((id) => {
            const signIn = this.signInById(id);
            const apiKey = this.apiKeyById(id);
            // A provider with only a sign-in keeps its own wording, such as the free models of OpenCode.
            const onlySignInLabel = apiKey === undefined ? signIn?.optionLabel : undefined;
            const label = onlySignInLabel ?? signIn?.label ?? apiKey?.label ?? id;

            // A provider with only a sign-in starts it at once, so the web page opens a tab for the link.
            const opensLink = apiKey === undefined && signIn?.isFree !== true;

            return opensLink ? { id: `${PROVIDER_CHOICE_PREFIX}${id}`, label, opensLink: true } : { id: `${PROVIDER_CHOICE_PREFIX}${id}`, label };
        });

        return [{ id: `${PROVIDER_CHOICE_PREFIX}claude`, label: 'Claude' }, ...otherOptions];
    }

    // The ways a provider can be used. A provider with one way starts it at once.
    private async chooseProvider(id: string): Promise<void> {
        if (id === 'claude') {
            await this.ask({ kind: 'choice', prompt: 'How would you like to use Claude?', options: [{ id: 'subscription', label: 'Subscription', opensLink: true }, { id: 'apiKey', label: 'API key' }] });

            return;
        }

        const signIn = this.signInById(id);
        const apiKey = this.apiKeyById(id);

        if (signIn !== undefined && apiKey !== undefined) {
            const options = id === 'opencode'
                ? [{ id, label: 'Free models' }, { id: `${KEY_CHOICE_PREFIX}${id}`, label: 'My account (API key)' }]
                : [{ id, label: 'Subscription', opensLink: true }, { id: `${KEY_CHOICE_PREFIX}${id}`, label: 'API key' }];

            await this.ask({ kind: 'choice', prompt: `How would you like to use ${signIn.label}?`, options });

            return;
        }

        if (signIn !== undefined) {
            await this.beginSignIn(signIn);

            return;
        }

        if (apiKey !== undefined) {
            await this.askSecret(apiKey);
        }
    }

    private isKnownProvider(id: string): boolean {
        return id === 'claude' || this.signInById(id) !== undefined || this.apiKeyById(id) !== undefined;
    }

    private cancelSessions(): void {
        const session = this.session;
        const deviceSession = this.deviceSession;

        this.session = undefined;
        this.deviceSession = undefined;
        session?.cancel();
        deviceSession?.cancel();
    }

    // Runs one step after the answers and steps before it.
    private serial(step: () => Promise<void>): Promise<void> {
        const result = this.pending.then(step);

        this.pending = result.catch(() => undefined);

        return result;
    }

    private isClosed(): boolean {
        return this.closed;
    }

    isStarting(): boolean {
        return this.starting;
    }

    whenStarted(): Promise<undefined> {
        return this.started.promise;
    }

    isSetupBot(botId: string): boolean {
        return botId === this.options.botId;
    }

    close(): void {
        this.closed = true;
        this.cancelSessions();
    }

    start(): Promise<void> {
        if (this.isClosed()) {
            return Promise.resolve();
        }

        this.starting = true;
        this.started = Promise.withResolvers<undefined>();
        const { resolve: endStart } = this.started;
        const result = this.pending.then(async () => {
            try {
                if (!this.closed) {
                    await this.restore();
                }
            } catch {
                console.error('Could not start Claude setup.');
                // Offers the choice again, so setup can be answered without another restart.
                await this.fail('Setup could not start. Check the server log.');
            } finally {
                this.starting = false;
                endStart(undefined);
            }
        });

        this.pending = result.catch(() => undefined);

        return result;
    }

    private async restore(): Promise<void> {
        const saved = await this.options.settings.get(SETUP_STATE_KEY);

        if (saved !== undefined) {
            this.state = JSON.parse(saved) as SetupState;
        }

        if (this.isClosed()) {
            return;
        }

        if (this.state.step === 'device') {
            // A link sign-in does not survive a restart. Its link and code are closed.
            await this.retireActive();
            this.state = { ...this.kept(), step: this.state.ready === true ? 'done' : 'choice' };
        }

        const claudeMode = this.state.mode ?? this.state.claudeMode;
        const connected = await this.isConnected(claudeMode);

        if (this.isClosed()) {
            return;
        }

        if (connected === true || (connected === undefined && this.state.step === 'done' && claudeMode !== undefined)) {
            await this.ready();

            return;
        }

        // Only a CloudBot that connected a provider before needs to find it again. Asking every provider CLI takes long, so a fresh one skips it.
        const hadProvider = this.state.step === 'done' || this.state.ready === true;
        const firstSignInId = hadProvider ? await this.firstSignedInId() : undefined;
        const firstSignIn = firstSignInId === undefined ? undefined : this.connectedById(firstSignInId);

        if (this.isClosed()) {
            return;
        }

        if (firstSignIn !== undefined) {
            await this.ready(firstSignIn);

            return;
        }

        if (this.state.step === 'code' || this.state.step === 'login') {
            await this.retireActive();
            await this.beginLogin();

            return;
        }

        if (this.state.step === 'done' || this.state.ready === true) {
            await this.fail('No AI provider is connected anymore.');

            return;
        }

        if (this.state.messageId === undefined) {
            const history = await this.options.messages.listByBot(this.options.botId, { limit: 200 });
            const active = history.findLast((message) => {
                const body = message.content as MessageBody;

                return (this.state.step === 'choice' && body.kind === 'choice' && body.chosenId === undefined)
                    // A form with a site belongs to the bot, not to the setup.
                    || (this.state.step === 'secret' && body.kind === 'secureForm' && !body.submitted && body.site === undefined);
            });

            if (active !== undefined) {
                this.state.messageId = active.id;
                await this.persist();
            }
        }

        if (this.state.messageId !== undefined) {
            const message = await this.options.messages.getById(this.state.messageId);
            const body = message?.content as MessageBody | undefined;

            // Recover if the process stopped between marking an answer and saving the next step.
            if (body?.kind === 'choice' && body.chosenId === 'subscription') {
                await this.beginLogin();

                return;
            }

            if (body?.kind === 'choice' && body.chosenId === 'apiKey') {
                await this.askSecret();

                return;
            }

            const chosenSignIn = body?.kind === 'choice' && body.chosenId !== undefined ? this.signInById(body.chosenId) : undefined;

            if (chosenSignIn !== undefined) {
                await this.beginSignIn(chosenSignIn);

                return;
            }

            const chosenKey = body?.kind === 'choice' ? this.apiKeyByChoice(body.chosenId) : undefined;
            const keyVariant = body?.kind === 'choice' ? this.apiKeyVariantByChoice(body.chosenId) : undefined;

            if (chosenKey !== undefined) {
                if (keyVariant === undefined) {
                    await this.chooseApiKey(chosenKey);
                } else {
                    await this.askSecret(chosenKey, keyVariant);
                }

                return;
            }

            const chosenProvider = body?.kind === 'choice' && body.chosenId?.startsWith(PROVIDER_CHOICE_PREFIX) === true
                ? body.chosenId.slice(PROVIDER_CHOICE_PREFIX.length)
                : undefined;

            if (chosenProvider !== undefined && this.isKnownProvider(chosenProvider)) {
                await this.chooseProvider(chosenProvider);

                return;
            }

            // A provider list from an older version misses the newer providers, so it is closed and posted again.
            const currentIds = this.providerOptions()
                .map(option => option.id)
                .join(',');
            const isOldList = body?.kind === 'choice' && body.chosenId === undefined && this.state.step === 'choice'
                && body.options.map(option => option.id)
                    .join(',') !== currentIds;

            if (isOldList) {
                // Closing the old list edits it in place, so it runs beside posting the new one.
                const closing = this.options.chat.updateSetupMessage(this.state.messageId, { kind: 'text', text: 'This list was replaced by a newer one.' });
                const asking = this.askMode();

                await Promise.all([closing, asking]);

                return;
            }

            if (body !== undefined && !(body.kind === 'secureForm' && body.submitted)) {
                return;
            }
        }

        if (this.state.mode === 'apiKey' || this.state.keyFor !== undefined) {
            const apiKey = this.state.keyFor === undefined ? undefined : this.apiKeyById(this.state.keyFor);
            const keyVariant = this.apiKeyVariantByMethod(apiKey, this.state.keyMethod);

            await this.askSecret(apiKey, keyVariant);

            return;
        }

        await this.say('Hello! Connect an AI provider to get started. You can connect more later.');

        if (this.options.localMode) {
            await this.say(LOCAL_MODE_LINE);
        }

        if (this.options.noBrowser === 'notInstalled') {
            await this.say(NO_BROWSER_LINE);
        }

        if (this.options.noBrowser === 'leftover') {
            await this.say(LEFTOVER_BROWSER_LINE);
        }

        await this.askMode();
    }

    private async isConnected(mode: SetupMode | undefined = this.state.mode): Promise<boolean | undefined> {
        if (mode === 'apiKey') {
            return this.options.vault.has(API_KEY_NAME);
        }

        if (mode !== 'subscription') {
            return false;
        }

        try {
            const status = await this.options.authStatus();

            return status.isLoggedIn;
        } catch {
            // An unavailable status does not mean the user signed out.
            return undefined;
        }
    }

    answer(botId: string, messageId: string, action: SetupAction, value: string): Promise<ChatMessage> {
        const result = this.pending.then(() => this.accept(botId, messageId, action, value));

        // A rejected answer must not block later answers. The caller receives the rejection.
        this.pending = result.catch(() => undefined);

        return result;
    }

    private async accept(botId: string, messageId: string, action: SetupAction, value: string): Promise<ChatMessage> {
        const message = await this.options.messages.getById(messageId);
        const switching = this.state.step === 'secret' && action === 'choice' && value === 'subscription';
        const signingOut = this.state.step === 'done' && action === 'choice' && value === 'signOut';
        // A choice on the provider list the setup posts after it is done.
        const offering = this.state.step === 'done' && action === 'choice' && value !== 'signOut';
        const expectedKind = action === 'code' ? 'codeField' : action === 'secret' || switching ? 'secureForm' : 'choice';
        // A provider whose page shows a code asks for it while its sign-in runs.
        const pastingCode = this.state.step === 'device' && action === 'code';

        if (this.closed || botId !== this.options.botId || message?.botId !== botId || message.kind !== expectedKind
            || (!switching && !signingOut && !offering && !pastingCode && this.state.step !== action) || this.state.messageId !== messageId) {
            throw new SetupAnswerError('This setup question is no longer active.');
        }

        if (value.trim().length === 0 || (action === 'code' && /[\r\n\0]/.test(value))) {
            throw new SetupAnswerError('Enter a valid value.');
        }

        const signIn = action === 'choice' ? this.signInById(value) : undefined;
        const chosenKey = action === 'choice' ? this.apiKeyByChoice(value) : undefined;
        const keyVariant = action === 'choice' ? this.apiKeyVariantByChoice(value) : undefined;
        const providerChoice = action === 'choice' && value.startsWith(PROVIDER_CHOICE_PREFIX) ? value.slice(PROVIDER_CHOICE_PREFIX.length) : undefined;
        const chosenProvider = providerChoice !== undefined && this.isKnownProvider(providerChoice) ? providerChoice : undefined;
        const keyProvider = action === 'secret' && this.state.keyFor !== undefined ? this.apiKeyById(this.state.keyFor) : undefined;
        const keyProviderVariant = this.apiKeyVariantByMethod(keyProvider, this.state.keyMethod);

        if (action === 'choice' && value === 'signOut' && !signingOut) {
            throw new SetupAnswerError('Choose a provider.');
        }

        if (action === 'choice' && value !== 'subscription' && value !== 'apiKey' && signIn === undefined && chosenKey === undefined && chosenProvider === undefined && !signingOut) {
            throw new SetupAnswerError('Choose a provider.');
        }

        const trimmedKey = value.trim();

        if (action === 'secret' && (trimmedKey.length === 0 || /[^\x21-\x7e]/u.test(trimmedKey))) {
            throw new SetupAnswerError('Enter a key using printable ASCII without spaces.');
        }

        const body = message.content as MessageBody;

        if ((body.kind === 'choice' && body.chosenId !== undefined)
            || ((body.kind === 'codeField' || body.kind === 'secureForm') && body.submitted)) {
            throw new SetupAnswerError('This setup question was already answered.');
        }

        let status: number | undefined;
        let unchecked = false;

        if (action === 'secret') {
            try {
                const checkKey = keyProviderVariant?.checkKey ?? keyProvider?.checkKey ?? this.options.checkKey;

                status = await checkKey(trimmedKey);
                unchecked = status !== 401 && status !== 403 && (status < 200 || status >= 300);
            } catch {
                unchecked = true;
            }

            if (this.isClosed()) {
                throw new SetupAnswerError('Setup is closed.');
            }
        }

        const answeredBody: MessageBody = body.kind === 'choice'
            ? { ...body, chosenId: value }
            : { ...body, submitted: true } as MessageBody;
        const answered = await this.options.chat.updateSetupMessage(messageId, answeredBody);

        try {
            if (signingOut) {
                await this.signOutOfClaude();
            } else if (chosenProvider !== undefined) {
                await this.chooseProvider(chosenProvider);
            } else if (signIn !== undefined) {
                await this.beginSignIn(signIn);
            } else if (chosenKey !== undefined) {
                if (keyVariant === undefined) {
                    await this.chooseApiKey(chosenKey);
                } else {
                    await this.askSecret(chosenKey, keyVariant);
                }
            } else if (pastingCode) {
                const pastedCode = value.trim();

                this.deviceSession?.submitCode?.(pastedCode);
            } else if (action === 'choice') {
                if (value === 'subscription') {
                    await this.beginLogin();
                } else {
                    await this.askSecret();
                }
            } else if (action === 'secret') {
                if (unchecked) {
                    // An unchecked key is never stored, so a mistyped key cannot end setup.
                    await this.say(`Could not reach ${keyProvider?.site ?? 'Anthropic'} to check the key. Try again.`);
                    await this.askSecret(keyProvider, keyProviderVariant);
                } else if (status === 401 || status === 403) {
                    await this.say('The key was rejected. Try another key.');
                    await this.askSecret(keyProvider, keyProviderVariant);
                } else if (keyProvider === undefined) {
                    this.options.vault.set(API_KEY_NAME, trimmedKey);
                    await this.ready(undefined, undefined, true);
                } else {
                    this.options.vault.set(keyProvider.secretName, trimmedKey);
                    await this.ready({ id: keyProvider.id, label: keyProvider.label }, keyProviderVariant?.method ?? 'apiKey', true);
                }
            } else {
                const session = this.session;

                if (session === undefined) {
                    await this.fail('Sign-in expired.');
                } else {
                    session.submitCode(value);
                }
            }
        } catch {
            // Dependency errors can include secrets. Only fixed text reaches chat or logs.
            await this.fail('Could not connect the provider.');
        }

        return answered;
    }

    private async beginLogin(): Promise<void> {
        if (this.isClosed()) {
            return;
        }

        this.state = { ...this.kept(), step: 'login', mode: 'subscription' };
        await this.persist();

        if (this.isClosed()) {
            return;
        }

        try {
            const session = this.options.startLogin();

            this.session = session;
            void this.watchLogin(session);
        } catch {
            await this.fail('Could not start Claude sign-in.');
        }
    }

    private async watchLogin(session: ClaudeLoginSession): Promise<void> {
        try {
            const url = await session.signInUrl;
            const noLinkResult = url === null ? await session.finished : undefined;
            const post = this.pending.then(async () => {
                if (this.closed || this.session !== session) {
                    return;
                }

                if (url === null && noLinkResult !== undefined) {
                    const result = noLinkResult;
                    const reason = result.ok ? 'Claude did not provide a sign-in link.' : LOGIN_FAILURES[result.reason];

                    await this.fail(reason);

                    return;
                }

                if (url === null) {
                    return;
                }

                const link = await this.post({
                    kind: 'link', text: 'Sign in on the Anthropic page.', label: 'Sign in to Claude', url,
                });

                this.state = { ...this.kept(), step: 'code', mode: 'subscription', ...(link ? { linkMessageId: link.id } : {}) };
                await this.ask({ kind: 'codeField', prompt: 'Paste the sign-in code here.', placeholder: 'Sign-in code', submitted: false });
            });

            this.pending = post.catch(() => undefined);
            await post;

            const result = await session.finished;
            const report = this.pending.then(async () => {
                if (this.closed || this.session !== session || this.state.step !== 'code') {
                    return;
                }

                if (result.ok && await this.isConnected() !== false) {
                    await this.ready(undefined, undefined, true);
                } else {
                    const reason = result.ok ? 'Claude did not confirm sign-in.' : LOGIN_FAILURES[result.reason];

                    await this.fail(reason);
                }
            });

            this.pending = report.catch(() => undefined);
            await report;
        } catch {
            const failure = this.pending.then(async () => {
                if (!this.closed && this.session === session) {
                    await this.fail('Could not start Claude sign-in.');
                }
            });

            this.pending = failure.catch(() => undefined);
            await this.pending;
        }
    }

    private async retireActive(): Promise<void> {
        if (this.state.linkMessageId !== undefined) {
            await this.options.chat.updateSetupMessage(this.state.linkMessageId, { kind: 'text', text: 'Sign-in link closed.' });
        }

        if (this.state.messageId === undefined) {
            return;
        }

        const stored = await this.options.messages.getById(this.state.messageId);
        const body = stored?.content as MessageBody | undefined;

        if (body?.kind === 'codeField' || body?.kind === 'secureForm') {
            await this.options.chat.updateSetupMessage(this.state.messageId, { ...body, submitted: true });
        }
    }

    // Without a provider this connects Claude, with one it connects that provider.
    // A fresh connection comes from the owner in this chat. A restart only restores one, so it keeps the provider the bot has.
    private async ready(signIn?: ConnectedProvider, method?: ProviderMethod, isFresh = false): Promise<void> {
        const mode = signIn === undefined ? this.state.mode ?? this.state.claudeMode : undefined;
        const wasDone = this.state.step === 'done';
        const connection = signIn?.id ?? mode;

        if (connection === undefined || this.isClosed()) {
            return;
        }

        await (method === undefined ? this.options.connect(connection) : this.options.connect(connection, method));
        if (isFresh) {
            await this.options.useProvider?.(signIn?.id ?? 'claude');
        }

        await this.retireActive();
        this.session = undefined;
        this.deviceSession = undefined;
        const previousMessageId = this.state.messageId;

        this.state = { ...this.kept(), step: 'done', ready: true, ...(mode === undefined ? {} : { mode, claudeMode: mode }) };
        if (wasDone && previousMessageId !== undefined) {
            this.state.messageId = previousMessageId;
        }
        await this.persist();

        if (!wasDone || isFresh) {
            await this.post({ kind: 'text', text: `${signIn?.label ?? 'Claude'} is ready. What would you like to do?`, ...(isFresh ? { providerSwitched: true } : {}) });
        }

        if (mode === 'subscription' && this.options.signOut !== undefined && this.state.messageId === undefined) {
            await this.askSignOut();
        }
    }

    private async askSignOut(): Promise<void> {
        await this.ask({
            kind: 'choice', prompt: 'This signs out only CloudBot\'s Claude login. Your own Claude Code login is not touched.',
            options: [{ id: 'signOut', label: 'Sign out' }],
        });
    }

    private async signOutOfClaude(): Promise<void> {
        const { signOut } = this.options;

        if (signOut === undefined) {
            return;
        }

        try {
            await signOut();
        } catch {
            await this.say('Could not sign out of Claude. Try again.');
            await this.askSignOut();

            return;
        }

        // Claude is gone. The chats stay open only when another provider is still signed in.
        const otherProviders = await this.signedInIds();

        if (otherProviders.length > 0) {
            this.state = { step: 'done', ready: true };
            await this.persist();
            await this.say('Signed out of Claude.');

            return;
        }

        this.state = { step: 'choice' };
        await this.askMode();
    }

    private async fail(text: string): Promise<void> {
        this.cancelSessions();
        await this.retireActive();
        await this.say(text);

        // When another provider is still connected, the chats stay open and the owner can ask for the list again.
        const connectedProviders = this.state.ready === true ? await this.connectedProviders() : [];

        if (connectedProviders.length > 0) {
            this.state = { ...this.kept(), step: 'done', ...(this.state.claudeMode === undefined ? {} : { mode: this.state.claudeMode }) };
            await this.persist();

            return;
        }

        this.state = { step: 'choice' };
        await this.askMode();
    }

    private async askMode(): Promise<void> {
        this.state = { ...this.kept(), step: 'choice' };
        await this.persist();
        await this.ask({ kind: 'choice', prompt: 'Which AI provider would you like to use?', options: this.providerOptions() });
    }

    private async beginSignIn(signIn: ProviderSignIn): Promise<void> {
        if (this.isClosed()) {
            return;
        }

        this.state = { ...this.kept(), step: 'device', signIn: signIn.id };
        await this.persist();

        try {
            const session = signIn.start();

            this.deviceSession = session;
            void this.watchSignIn(signIn, session);
        } catch {
            await this.fail(`Could not start ${signIn.label} sign-in.`);
        }
    }

    private async watchSignIn(signIn: ProviderSignIn, session: DeviceSignInSession): Promise<void> {
        const isCurrent = (): boolean => !this.closed && this.deviceSession === session;

        try {
            const link = await session.link;

            await this.serial(async () => {
                if (!isCurrent()) {
                    return;
                }

                // A provider without a sign-in, like the free opencode models, ends without a link.
                if (link === null) {
                    return;
                }

                const text = link.code === undefined
                    ? `Sign in on the ${signIn.site} page.`
                    : `Sign in on the ${signIn.site} page and enter this code: ${link.code}`;
                const posted = await this.post({ kind: 'link', text, label: `Sign in to ${signIn.label}`, url: link.url });

                if (posted !== undefined) {
                    this.state.linkMessageId = posted.id;
                    await this.persist();
                }

                if (link.needsCode === true) {
                    await this.ask({ kind: 'codeField', prompt: `Paste the code from the ${signIn.site} page here.`, placeholder: 'Sign-in code', submitted: false });
                }
            });

            const result = await session.finished;

            await this.serial(async () => {
                if (!isCurrent()) {
                    return;
                }

                const isSignedIn = result.ok ? await signIn.isSignedIn() : false;

                if (result.ok && isSignedIn !== false) {
                    await this.ready({ id: signIn.id, label: signIn.label }, 'signIn', true);
                } else if (link === null && result.ok) {
                    await this.fail(`${signIn.label} did not provide a sign-in link.`);
                } else {
                    await this.fail(result.ok ? `${signIn.label} did not confirm sign-in.` : result.reason);
                }
            });
        } catch {
            await this.serial(async () => {
                if (isCurrent()) {
                    await this.fail(`Could not start ${signIn.label} sign-in.`);
                }
            });
        }
    }

    private async ask(body: MessageBody): Promise<void> {
        const message = await this.post(body);

        if (message === undefined) {
            return;
        }

        this.state.messageId = message.id;
        await this.persist();
    }

    // Without a provider this asks for the Anthropic key.
    private async chooseApiKey(apiKey: ProviderApiKey): Promise<void> {
        const variants = apiKey.variants ?? [];

        if (variants.length === 0) {
            await this.askSecret(apiKey);

            return;
        }

        const options = variants.map(variant => ({ id: `${KEY_CHOICE_PREFIX}${apiKey.id}:${variant.method}`, label: variant.label }));

        await this.ask({ kind: 'choice', prompt: `Which ${apiKey.label} account do you have?`, options });
    }

    private async askSecret(apiKey?: ProviderApiKey, variant?: ProviderApiKeyVariant): Promise<void> {
        if (apiKey === undefined) {
            this.state = { ...this.kept(), step: 'secret', mode: 'apiKey' };
            await this.persist();
            await this.ask({ kind: 'secureForm', prompt: 'Add your Anthropic API key.', secretName: API_KEY_NAME, submitted: false });

            return;
        }

        this.state = {
            ...this.kept(),
            step: 'secret',
            keyFor: apiKey.id,
            ...(variant === undefined ? {} : { keyMethod: variant.method }),
        };
        await this.persist();
        const label = variant?.label ?? apiKey.label;
        const site = variant?.site ?? apiKey.site;

        await this.ask({ kind: 'secureForm', prompt: `Add your ${label} API key from ${site}.`, secretName: apiKey.secretName, submitted: false });
    }

    private async say(text: string): Promise<void> {
        await this.post({ kind: 'text', text });
    }

    private async post(body: MessageBody): Promise<ChatMessage | undefined> {
        if (this.isClosed()) {
            return undefined;
        }

        return this.options.chat.postSetupMessage(this.options.botId, body);
    }

    private async persist(): Promise<void> {
        const serialized = JSON.stringify(this.state);

        await this.options.settings.set(SETUP_STATE_KEY, serialized);
    }
}

export { SetupConversation, SetupAnswerError, API_KEY_NAME };
export type { DeviceSignInLink, DeviceSignInResult, DeviceSignInSession, ProviderApiKey, ProviderApiKeyVariant, ProviderMethod, ProviderSignIn, SetupMode, SetupAction, SetupConversationOptions };
