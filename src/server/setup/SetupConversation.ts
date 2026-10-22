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
}

interface DeviceSignInLink {
    url: string;
    // The code the owner types on the provider's page. The message that shows it is replaced when the sign-in ends.
    code?: string | undefined;
}

type DeviceSignInResult = { ok: true } | { ok: false; reason: string };

interface DeviceSignInSession {
    link: Promise<DeviceSignInLink | null>;
    finished: Promise<DeviceSignInResult>;
    cancel: () => void;
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
}

interface ProviderOption {
    id: string;
    label: string;
}

interface SetupConversationOptions {
    botId: string;
    chat: ChatService;
    messages: MessageStore;
    settings: SettingsStore;
    vault: Pick<Vault, 'has' | 'set' | 'delete'>;
    startLogin: () => ClaudeLoginSession;
    authStatus: () => Promise<ClaudeAuthStatus>;
    // Called when Claude or another provider is connected.
    connect: (connection: SetupMode | ProviderId) => Promise<void>;
    // The providers that sign in by link. Each one is a choice next to the two Claude ways.
    signIns?: ProviderSignIn[] | undefined;
    checkKey: (key: string) => Promise<number>;
    // Runs the CLI's own logout for CloudBot's login only.
    signOut?: () => Promise<void>;
    // True when no agent user is set, so the bot runs as the owner's account.
    localMode: boolean;
    // Why the bot has no browser on this computer. The setup says so once.
    noBrowser?: 'notInstalled' | 'leftover' | undefined;
}

const SETUP_STATE_KEY = 'claude.setup';
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

    private async signedInIds(): Promise<ProviderId[]> {
        const signIns = this.options.signIns ?? [];
        const checks = signIns.map(signIn => signIn.isSignedIn()
            .catch(() => undefined));
        const statuses = await Promise.all(checks);

        return signIns.filter((_signIn, index) => statuses[index] === true)
            .map(signIn => signIn.id);
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

    private providerOptions(): ProviderOption[] {
        const signIns = this.options.signIns ?? [];
        const linkOptions = signIns.map(signIn => ({ id: signIn.id, label: signIn.label }));

        return [{ id: 'subscription', label: 'Claude subscription' }, { id: 'apiKey', label: 'Claude API key' }, ...linkOptions];
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

        const signedIn = await this.signedInIds();
        const firstSignIn = signedIn[0] === undefined ? undefined : this.signInById(signedIn[0]);

        if (this.isClosed()) {
            return;
        }

        if (firstSignIn !== undefined && (this.state.step === 'done' || this.state.ready === true)) {
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

            if (body !== undefined && !(body.kind === 'secureForm' && body.submitted)) {
                return;
            }
        }

        if (this.state.mode === 'apiKey') {
            await this.askSecret();

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

        if (this.closed || botId !== this.options.botId || message?.botId !== botId || message.kind !== expectedKind
            || (!switching && !signingOut && !offering && this.state.step !== action) || this.state.messageId !== messageId) {
            throw new SetupAnswerError('This setup question is no longer active.');
        }

        if (value.trim().length === 0 || (action === 'code' && /[\r\n\0]/.test(value))) {
            throw new SetupAnswerError('Enter a valid value.');
        }

        const signIn = action === 'choice' ? this.signInById(value) : undefined;

        if (action === 'choice' && value === 'signOut' && !signingOut) {
            throw new SetupAnswerError('Choose a provider.');
        }

        if (action === 'choice' && value !== 'subscription' && value !== 'apiKey' && signIn === undefined && !signingOut) {
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
                status = await this.options.checkKey(trimmedKey);
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
            } else if (signIn !== undefined) {
                await this.beginSignIn(signIn);
            } else if (action === 'choice') {
                if (value === 'subscription') {
                    await this.beginLogin();
                } else {
                    await this.askSecret();
                }
            } else if (action === 'secret') {
                if (unchecked) {
                    // An unchecked key is never stored, so a mistyped key cannot end setup.
                    await this.say('Could not reach Anthropic to check the key. Try again.');
                    await this.askSecret();
                } else if (status === 401 || status === 403) {
                    await this.say('The key was rejected. Try another key.');
                    await this.askSecret();
                } else {
                    this.options.vault.set(API_KEY_NAME, trimmedKey);
                    await this.ready();
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
            await this.fail('Could not connect Claude.');
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
                    await this.ready();
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

    // Without a sign-in this connects Claude, with one it connects that provider.
    private async ready(signIn?: ProviderSignIn): Promise<void> {
        const mode = signIn === undefined ? this.state.mode ?? this.state.claudeMode : undefined;
        const wasDone = this.state.step === 'done';
        const connection = signIn?.id ?? mode;

        if (connection === undefined || this.isClosed()) {
            return;
        }

        await this.options.connect(connection);
        await this.retireActive();
        this.session = undefined;
        this.deviceSession = undefined;
        const previousMessageId = this.state.messageId;

        this.state = { ...this.kept(), step: 'done', ready: true, ...(mode === undefined ? {} : { mode, claudeMode: mode }) };
        if (wasDone && previousMessageId !== undefined) {
            this.state.messageId = previousMessageId;
        }
        await this.persist();

        if (!wasDone) {
            await this.say(`${signIn?.label ?? 'Claude'} is ready. What would you like to do?`);
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

                if (link === null) {
                    await this.fail(`${signIn.label} did not provide a sign-in link.`);

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
            });

            const result = await session.finished;

            await this.serial(async () => {
                if (!isCurrent()) {
                    return;
                }

                const isSignedIn = result.ok ? await signIn.isSignedIn() : false;

                if (result.ok && isSignedIn !== false) {
                    await this.ready(signIn);
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

    private async askSecret(): Promise<void> {
        this.state = { ...this.kept(), step: 'secret', mode: 'apiKey' };
        await this.persist();
        await this.ask({ kind: 'secureForm', prompt: 'Add your Anthropic API key.', secretName: API_KEY_NAME, submitted: false });
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
export type { DeviceSignInLink, DeviceSignInResult, DeviceSignInSession, ProviderSignIn, SetupMode, SetupAction, SetupConversationOptions };
