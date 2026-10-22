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
import type { DeviceSignInResult } from './SetupConversation.ts';

const USER_CODE = 'ABCD-1234';

interface ProviderFixture {
    chat: ChatService;
    setup: SetupConversation;
    botId: string;
    connect: Mock<(_: string) => Promise<void>>;
    finishChatgpt: (result: DeviceSignInResult) => void;
    startClaudeLogin: Mock<() => ClaudeLoginSession>;
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
        const connect = vi.fn<(_: string) => Promise<void>>()
            .mockResolvedValue(undefined);
        let isChatgptSignedIn = false;
        const finished = Promise.withResolvers<DeviceSignInResult>();
        const claudeSession: ClaudeLoginSession = {
            signInUrl: Promise.resolve('https://claude.ai/login'),
            submitCode: vi.fn(),
            cancel: vi.fn(),
            finished: new Promise(() => undefined),
        };
        const startClaudeLogin = vi.fn(() => claudeSession);
        const chat = new ChatService({ botStore: bots, messageStore: messages, runner: new FakeAgentRunner([]), dataDir });
        const setup = new SetupConversation({
            botId: bot.id, chat, messages, settings,
            vault: { delete: () => undefined, has: () => false, set: () => undefined },
            checkKey: () => Promise.resolve(200),
            connect,
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
                isSignedIn: () => Promise.resolve(isChatgptSignedIn),
            }],
        });

        chat.setSetup(setup);
        await setup.start();

        return {
            chat, setup, botId: bot.id, connect, startClaudeLogin,
            finishChatgpt: (result) => {
                isChatgptSignedIn = result.ok;
                finished.resolve(result);
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
            .toMatchObject({ options: [{ id: 'subscription' }, { id: 'apiKey' }, { id: 'chatgpt', label: 'ChatGPT' }] });
        expect(context.setup.isDone())
            .toBe(false);
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
            .toHaveBeenCalledWith('chatgpt');
        expect((await texts(context)).join(' '))
            .not.toContain(USER_CODE);
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
