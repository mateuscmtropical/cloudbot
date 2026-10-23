import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatMessage } from '../../shared/chatTypes.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import { ChatService } from '../chat/ChatService.ts';
import { CLEANUP_RETRIES } from '../chat/testCleanup.ts';
import type { ClaudeLoginSession } from '../claudeAuth/startClaudeLogin.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import { SettingsStore } from '../store/SettingsStore.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { SetupConversation } from './SetupConversation.ts';
import type { DeviceSignInResult, SetupConversationOptions } from './SetupConversation.ts';

const USER_CODE = 'ABCD-1234';

interface ProviderFixture {
    chat: ChatService;
    setup: SetupConversation;
    botId: string;
    connect: Mock<(_: string, method?: string) => Promise<void>>;
    useProvider: Mock<(provider: string) => Promise<void>>;
    finishChatgpt: (result: DeviceSignInResult) => void;
    finishGemini: (result: DeviceSignInResult) => void;
    startClaudeLogin: Mock<() => ClaudeLoginSession>;
    submitGeminiCode: Mock<(code: string) => void>;
    checkGeminiKey: Mock<(key: string) => Promise<number>>;
    checkOpenCodeZenKey: Mock<(key: string) => Promise<number>>;
    checkOpenCodeGoKey: Mock<(key: string) => Promise<number>>;
    secrets: Map<string, string>;
    restart: () => Promise<SetupConversation>;
    // The providers asked whether they are signed in, in the order of the asks.
    checkedProviders: string[];
    // Makes the OpenCode check wait forever, like a CLI that is slow to open.
    holdOpenCodeCheck: () => void;
}

describe('setup conversation with other providers', () => {
    let opened: OpenedDatabase;
    let dataDir: string;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-setup-providers-'));
        opened = await openDatabase(join(dataDir, 'test.db'));
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    async function fixture(): Promise<ProviderFixture> {
        const bots = new BotStore(opened.db);
        const bot = await bots.create({ name: 'CloudBot', title: 'Assistant', description: '' });
        const messages = new MessageStore(opened.db);
        const settings = new SettingsStore(opened.db);
        const connect = vi.fn<(_: string, method?: string) => Promise<void>>()
            .mockResolvedValue(undefined);
        const useProvider = vi.fn<(provider: string) => Promise<void>>()
            .mockResolvedValue(undefined);
        let isChatgptSignedIn = false;
        let isGeminiSignedIn = false;
        let isOpenCodeCheckHeld = false;
        const checkedProviders: string[] = [];
        const finished = Promise.withResolvers<DeviceSignInResult>();
        const geminiFinished = Promise.withResolvers<DeviceSignInResult>();
        const submitGeminiCode = vi.fn<(code: string) => void>();
        const checkGeminiKey = vi.fn<(key: string) => Promise<number>>()
            .mockResolvedValue(200);
        const checkOpenCodeZenKey = vi.fn<(key: string) => Promise<number>>()
            .mockResolvedValue(200);
        const checkOpenCodeGoKey = vi.fn<(key: string) => Promise<number>>()
            .mockResolvedValue(200);
        const secrets = new Map<string, string>();
        const claudeSession: ClaudeLoginSession = {
            signInUrl: Promise.resolve('https://claude.ai/login'),
            submitCode: vi.fn(),
            cancel: vi.fn(),
            finished: new Promise(() => undefined),
        };
        const startClaudeLogin = vi.fn(() => claudeSession);
        const chat = new ChatService({ botStore: bots, messageStore: messages, runner: new FakeAgentRunner([]), dataDir });
        const setupOptions: SetupConversationOptions = {
            botId: bot.id, chat, messages, settings,
            vault: {
                delete: (name) => {
                    secrets.delete(name);
                },
                has: name => secrets.has(name),
                set: (name, value) => {
                    secrets.set(name, value);
                },
            },
            checkKey: () => Promise.resolve(200),
            connect,
            useProvider,
            authStatus: () => Promise.resolve({ isLoggedIn: false }),
            startLogin: startClaudeLogin,
            localMode: false,
            signIns: [{
                id: 'chatgpt',
                label: 'ChatGPT',
                site: 'OpenAI',
                start: () => ({
                    link: Promise.resolve({ url: 'https://auth.openai.com/codex/device', code: USER_CODE }),
                    finished: finished.promise,
                    cancel: vi.fn(),
                }),
                isSignedIn: () => {
                    checkedProviders.push('chatgpt');

                    return Promise.resolve(isChatgptSignedIn);
                },
            }, {
                id: 'gemini',
                label: 'Gemini',
                site: 'Google',
                start: () => ({
                    link: Promise.resolve({ url: 'https://accounts.google.com/o/oauth2/v2/auth', needsCode: true }),
                    finished: geminiFinished.promise,
                    cancel: vi.fn(),
                    submitCode: submitGeminiCode,
                }),
                isSignedIn: () => {
                    checkedProviders.push('gemini');

                    return Promise.resolve(isGeminiSignedIn);
                },
            }, {
                id: 'opencode',
                label: 'OpenCode',
                site: 'OpenCode',
                isFree: true,
                start: () => ({ link: Promise.resolve(null), finished: Promise.resolve({ ok: true }), cancel: vi.fn() }),
                isSignedIn: () => {
                    checkedProviders.push('opencode');

                    return isOpenCodeCheckHeld ? new Promise<undefined>(() => undefined) : Promise.resolve(undefined);
                },
            }],
            apiKeys: [{ id: 'gemini', label: 'Gemini', site: 'Google AI Studio', secretName: 'GEMINI_API_KEY', checkKey: checkGeminiKey }, {
                id: 'opencode',
                label: 'OpenCode',
                site: 'opencode.ai/auth',
                secretName: 'OPENCODE_API_KEY',
                checkKey: checkOpenCodeZenKey,
                variants: [
                    { method: 'apiKeyZen', label: 'OpenCode Zen', site: 'opencode.ai/auth', checkKey: checkOpenCodeZenKey },
                    { method: 'apiKeyGo', label: 'OpenCode Go', site: 'opencode.ai/auth', checkKey: checkOpenCodeGoKey },
                ],
            }],
        };
        const setup = new SetupConversation(setupOptions);

        chat.setSetup(setup);
        await setup.start();

        const restart = async (): Promise<SetupConversation> => {
            setup.close();
            const restored = new SetupConversation(setupOptions);

            chat.setSetup(restored);
            await restored.start();

            return restored;
        };

        return {
            chat, setup, botId: bot.id, connect, useProvider, startClaudeLogin, submitGeminiCode, checkGeminiKey,
            checkOpenCodeZenKey, checkOpenCodeGoKey, secrets, restart, checkedProviders,
            holdOpenCodeCheck: () => {
                isOpenCodeCheckHeld = true;
            },
            finishChatgpt: (result) => {
                isChatgptSignedIn = result.ok;
                finished.resolve(result);
            },
            finishGemini: (result) => {
                isGeminiSignedIn = result.ok;
                geminiFinished.resolve(result);
            },
        };
    }

    async function latest(context: ProviderFixture, kind: string): Promise<ChatMessage> {
        let found: ChatMessage | undefined;

        await vi.waitFor(async () => {
            const history = await context.chat.listMessages(context.botId);

            found = history?.filter(message => message.body.kind === kind)
                .at(-1);
            expect(found)
                .toBeDefined();
        });

        return found!;
    }

    async function texts(context: ProviderFixture): Promise<string[]> {
        const history = await context.chat.listMessages(context.botId) ?? [];

        return history.map(message => JSON.stringify(message.body));
    }

    it('lists every provider in the first card', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        expect(choice.body)
            .toEqual(expect.objectContaining({ options: [
                { id: 'provider:claude', label: 'Claude' },
                { id: 'provider:chatgpt', label: 'ChatGPT', opensLink: true },
                { id: 'provider:gemini', label: 'Gemini' },
                { id: 'provider:opencode', label: 'OpenCode' },
            ] }));
        expect(context.setup.isDone())
            .toBe(false);
    });

    it('does not ask the providers whether they are signed in on a fresh start', async () => {
        const context = await fixture();

        await latest(context, 'choice');
        expect(context.checkedProviders)
            .toEqual([]);
    });

    it('restores the first signed in provider without waiting for a slow one', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'chatgpt');
        context.finishChatgpt({ ok: true });
        await vi.waitFor(() => {
            expect(context.useProvider)
                .toHaveBeenCalledWith('chatgpt');
        });
        context.holdOpenCodeCheck();

        const restored = await context.restart();

        expect(restored.isDone())
            .toBe(true);
    });

    it('switches the bot to a provider when its sign-in ends and marks the ready message', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'chatgpt');
        context.finishChatgpt({ ok: true });

        await vi.waitFor(() => {
            expect(context.useProvider)
                .toHaveBeenCalledWith('chatgpt');
        });

        const ready = await latest(context, 'text');

        expect(ready.body)
            .toMatchObject({ text: 'ChatGPT is ready. What would you like to do?', providerSwitched: true });
    });

    it('switches the bot to a provider after its API key is stored', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'key:gemini');
        const form = await latest(context, 'secureForm');

        await context.chat.answerSetup(context.botId, form.id, 'secret', 'AIza-test-key');

        expect(context.useProvider)
            .toHaveBeenCalledWith('gemini');
    });

    it('offers free models without opening a tab', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'provider:opencode');
        const ways = await latest(context, 'choice');

        expect(ways.body)
            .toMatchObject({ options: [
                { id: 'opencode', label: 'Free models' },
                { id: 'key:opencode', label: 'My account (API key)' },
            ] });

        await context.chat.answerSetup(context.botId, ways.id, 'choice', 'opencode');

        await vi.waitFor(() => {
            expect(context.useProvider)
                .toHaveBeenCalledWith('opencode');
        });
    });

    it('restores the OpenCode free choice after a restart', async () => {
        const context = await fixture();
        const providerChoice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, providerChoice.id, 'choice', 'provider:opencode');
        const ways = await latest(context, 'choice');

        if (ways.body.kind !== 'choice') {
            throw new Error('OpenCode usage choice is missing.');
        }

        await context.chat.updateSetupMessage(ways.id, { ...ways.body, chosenId: 'opencode' });
        await context.restart();

        await vi.waitFor(() => {
            expect(context.useProvider)
                .toHaveBeenCalledWith('opencode');
        });
    });

    it('asks how to use a provider that has two ways', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'provider:gemini');
        const ways = await latest(context, 'choice');

        expect(ways.body)
            .toMatchObject({ prompt: 'How would you like to use Gemini?', options: [
                { id: 'gemini', label: 'Subscription', opensLink: true },
                { id: 'key:gemini', label: 'API key' },
            ] });
    });

    it('asks whether OpenCode should use free models or an account key', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'provider:opencode');
        const ways = await latest(context, 'choice');

        expect(ways.body)
            .toMatchObject({ prompt: 'How would you like to use OpenCode?', options: [
                { id: 'opencode', label: 'Free models' },
                { id: 'key:opencode', label: 'My account (API key)' },
            ] });
    });

    it('checks and stores an OpenCode Go key in the vault', async () => {
        const context = await fixture();
        const providerChoice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, providerChoice.id, 'choice', 'provider:opencode');
        const ways = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, ways.id, 'choice', 'key:opencode');
        const plans = await latest(context, 'choice');

        expect(plans.body)
            .toMatchObject({ prompt: 'Which OpenCode account do you have?', options: [
                { id: 'key:opencode:apiKeyZen', label: 'OpenCode Zen' },
                { id: 'key:opencode:apiKeyGo', label: 'OpenCode Go' },
            ] });

        await context.chat.answerSetup(context.botId, plans.id, 'choice', 'key:opencode:apiKeyGo');
        const form = await latest(context, 'secureForm');

        expect(form.body)
            .toMatchObject({ prompt: 'Add your OpenCode Go API key from opencode.ai/auth.', secretName: 'OPENCODE_API_KEY' });

        await context.chat.answerSetup(context.botId, form.id, 'secret', 'oc_sk_fake_key');

        expect(context.checkOpenCodeGoKey)
            .toHaveBeenCalledWith('oc_sk_fake_key');
        expect(context.checkOpenCodeZenKey)
            .not.toHaveBeenCalled();
        expect(context.secrets.get('OPENCODE_API_KEY'))
            .toBe('oc_sk_fake_key');
        expect(context.connect)
            .toHaveBeenCalledWith('opencode', 'apiKeyGo');
        expect(context.useProvider)
            .toHaveBeenCalledWith('opencode');
        expect((await texts(context)).join(' '))
            .not.toContain('oc_sk_fake_key');
    });

    it('goes straight to the sign-in of a provider that has one way', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'provider:chatgpt');
        const link = await latest(context, 'link');

        expect(link.body)
            .toMatchObject({ url: 'https://auth.openai.com/codex/device' });
    });

    it('signs in to ChatGPT with the code on the page, then closes the code', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'chatgpt');
        const link = await latest(context, 'link');

        expect(link.body)
            .toMatchObject({ kind: 'link', url: 'https://auth.openai.com/codex/device', text: `Sign in on the OpenAI page and enter this code: ${USER_CODE}` });

        context.finishChatgpt({ ok: true });

        await vi.waitFor(() => {
            expect(context.setup.isDone())
                .toBe(true);
        });
        expect(context.connect)
            .toHaveBeenCalledWith('chatgpt', 'signIn');
        expect((await texts(context)).join(' '))
            .not.toContain(USER_CODE);
    });

    it('stores a provider API key in the vault after checking it', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'key:gemini');
        const form = await latest(context, 'secureForm');

        expect(form.body)
            .toMatchObject({ prompt: 'Add your Gemini API key from Google AI Studio.', secretName: 'GEMINI_API_KEY' });

        await context.chat.answerSetup(context.botId, form.id, 'secret', 'AIza-test-key');

        expect(context.checkGeminiKey)
            .toHaveBeenCalledWith('AIza-test-key');
        expect(context.secrets.get('GEMINI_API_KEY'))
            .toBe('AIza-test-key');
        expect(context.connect)
            .toHaveBeenCalledWith('gemini', 'apiKey');
        expect(await context.setup.connectedProviders())
            .toEqual(['gemini']);
        expect((await texts(context)).join(' '))
            .not.toContain('AIza-test-key');
    });

    it('asks for the key again when the provider rejects it', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        context.checkGeminiKey.mockResolvedValue(400 + 1);
        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'key:gemini');
        const form = await latest(context, 'secureForm');

        await context.chat.answerSetup(context.botId, form.id, 'secret', 'wrong-key');
        const nextForm = await latest(context, 'secureForm');

        expect(nextForm.id)
            .not.toBe(form.id);
        expect(context.secrets.has('GEMINI_API_KEY'))
            .toBe(false);
    });

    it('passes the code the owner pastes to a sign-in that asks for one', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'gemini');
        const field = await latest(context, 'codeField');

        expect(field.body)
            .toMatchObject({ prompt: 'Paste the code from the Google page here.' });

        await context.chat.answerSetup(context.botId, field.id, 'code', ' 4/0Ab-pasted ');
        context.finishGemini({ ok: true });

        expect(context.submitGeminiCode)
            .toHaveBeenCalledWith('4/0Ab-pasted');
        await vi.waitFor(() => {
            expect(context.setup.isDone())
                .toBe(true);
        });
        expect((await texts(context)).join(' '))
            .not.toContain('4/0Ab-pasted');
    });

    it('keeps the chats open while the owner connects another provider', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'chatgpt');
        context.finishChatgpt({ ok: true });
        await vi.waitFor(() => {
            expect(context.setup.isDone())
                .toBe(true);
        });

        await context.setup.offerProviders();
        const offer = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, offer.id, 'choice', 'subscription');

        expect(context.startClaudeLogin)
            .toHaveBeenCalledOnce();
        expect(context.setup.isDone())
            .toBe(true);
        expect(await context.setup.connectedProviders())
            .toEqual(['chatgpt']);
    });

    it('offers the list again when the only sign-in fails', async () => {
        const context = await fixture();
        const choice = await latest(context, 'choice');

        await context.chat.answerSetup(context.botId, choice.id, 'choice', 'chatgpt');
        context.finishChatgpt({ ok: false, reason: 'ChatGPT sign-in timed out.' });

        await vi.waitFor(async () => {
            const lastChoice = await latest(context, 'choice');

            expect(lastChoice.id)
                .not.toBe(choice.id);
        });
        expect((await texts(context)).join(' '))
            .toContain('ChatGPT sign-in timed out.');
        expect(context.setup.isDone())
            .toBe(false);
    });
});
