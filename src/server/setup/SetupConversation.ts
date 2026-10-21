import type { ChatMessage, MessageBody } from '../../shared/chatTypes.ts';
import type { ChatService } from '../chat/ChatService.ts';
import type { ClaudeAuthStatus } from '../claudeAuth/getClaudeAuthStatus.ts';
import type { ClaudeLoginSession } from '../claudeAuth/startClaudeLogin.ts';
import type { MessageStore } from '../store/MessageStore.ts';
import type { SettingsStore } from '../store/SettingsStore.ts';
import type { Vault } from '../vault/Vault.ts';

type SetupMode = 'subscription' | 'apiKey';
type SetupAction = 'choice' | 'code' | 'secret';

interface SetupState {
    step: 'choice' | 'login' | 'code' | 'secret' | 'done';
    mode?: SetupMode;
    messageId?: string;
    linkMessageId?: string;
}

interface SetupConversationOptions {
    botId: string;
    chat: ChatService;
    messages: MessageStore;
    settings: SettingsStore;
    vault: Pick<Vault, 'has' | 'set' | 'delete'>;
    startLogin: () => ClaudeLoginSession;
    authStatus: () => Promise<ClaudeAuthStatus>;
    connect: (mode: SetupMode) => Promise<void>;
    checkKey: (key: string) => Promise<number>;
    // True when no agent user is set, so the bot runs as the owner's account.
    localMode: boolean;
}

const SETUP_STATE_KEY = 'claude.setup';
const API_KEY_NAME = 'ANTHROPIC_API_KEY';
const LOCAL_MODE_LINE = 'Local mode: I run as you, on this computer, with your files and your account.';
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
    private starting = true;
    private closed = false;
    private pending: Promise<unknown> = Promise.resolve();

    constructor(options: SetupConversationOptions) {
        this.options = options;
    }

    isDone(): boolean {
        return !this.starting && !this.closed && this.state.step === 'done';
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
        const session = this.session;

        this.session = undefined;
        session?.cancel();
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

        const connected = await this.isConnected();

        if (this.isClosed()) {
            return;
        }

        if (connected === true || (connected === undefined && this.state.step === 'done')) {
            await this.ready();

            return;
        }

        if (this.state.step === 'code' || this.state.step === 'login') {
            await this.retireActive();
            await this.beginLogin();

            return;
        }

        if (this.state.step === 'done') {
            await this.fail('Claude is no longer connected.');

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

        await this.say('Hello! Connect Claude to get started.');

        if (this.options.localMode) {
            await this.say(LOCAL_MODE_LINE);
        }

        await this.askMode();
    }

    private async isConnected(): Promise<boolean | undefined> {
        if (this.state.mode === 'apiKey') {
            return this.options.vault.has(API_KEY_NAME);
        }

        if (this.state.mode !== 'subscription') {
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
        const expectedKind = action === 'code' ? 'codeField' : action === 'secret' || switching ? 'secureForm' : 'choice';

        if (this.closed || botId !== this.options.botId || message?.botId !== botId || message.kind !== expectedKind
            || (!switching && this.state.step !== action) || this.state.messageId !== messageId) {
            throw new SetupAnswerError('This setup question is no longer active.');
        }

        if (value.trim().length === 0 || (action === 'code' && /[\r\n\0]/.test(value))) {
            throw new SetupAnswerError('Enter a valid value.');
        }

        if (action === 'choice' && value !== 'subscription' && value !== 'apiKey') {
            throw new SetupAnswerError('Choose subscription or API key.');
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
            if (action === 'choice') {
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

        this.state = { step: 'login', mode: 'subscription' };
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

                this.state = { step: 'code', mode: 'subscription', ...(link ? { linkMessageId: link.id } : {}) };
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

    private async ready(): Promise<void> {
        const mode = this.state.mode;
        const wasDone = this.state.step === 'done';

        if (mode === undefined || this.isClosed()) {
            return;
        }

        await this.options.connect(mode);
        await this.retireActive();
        this.session = undefined;
        this.state = { step: 'done', mode };
        await this.persist();

        if (!wasDone) {
            await this.say('Claude is ready. What would you like to do?');
        }
    }

    private async fail(text: string): Promise<void> {
        const session = this.session;

        this.session = undefined;
        session?.cancel();
        await this.retireActive();
        await this.say(text);
        await this.askMode();
    }

    private async askMode(): Promise<void> {
        this.state = { step: 'choice' };
        await this.persist();
        await this.ask({
            kind: 'choice', prompt: 'How would you like to connect Claude?',
            options: [{ id: 'subscription', label: 'Subscription' }, { id: 'apiKey', label: 'API key' }],
        });
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
        this.state = { step: 'secret', mode: 'apiKey' };
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
export type { SetupMode, SetupAction, SetupConversationOptions };
