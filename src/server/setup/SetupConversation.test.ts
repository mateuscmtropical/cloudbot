import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { ClaudeAuthStatus } from '../claudeAuth/getClaudeAuthStatus.ts';
import type { Hono } from 'hono';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatMessage } from '../../shared/chatTypes.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import { ChatService } from '../chat/ChatService.ts';
import { SetupAccess } from '../access/SetupAccess.ts';
import { createApp } from '../createApp.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import { SettingsStore } from '../store/SettingsStore.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import type { ClaudeLoginSession } from '../claudeAuth/startClaudeLogin.ts';
import { API_KEY_NAME, SetupConversation } from './SetupConversation.ts';

const SECRET = 'sk-ant-private-test-key';
const CODE = 'private-login-code';

interface Fixture {
    app: Hono;
    chat: ChatService;
    setup: SetupConversation;
    messages: MessageStore;
    settings: SettingsStore;
    botId: string;
    cookie: string;
    vault: Map<string, string>;
    session: ClaudeLoginSession;
    startLogin: Mock<() => ClaudeLoginSession>;
    connect: Mock<(_: string) => Promise<void>>;
    authStatus: Mock<() => Promise<ClaudeAuthStatus>>;
    runner: FakeAgentRunner;
    checkKey: Mock<(_: string) => Promise<number>>;
}

describe('setup conversation', () => {
    let opened: OpenedDatabase;
    let dataDir: string;
    let databaseFile: string;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-setup-'));
        databaseFile = join(dataDir, 'test.db');
        opened = await openDatabase(databaseFile);
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true });
    });

    async function fixture(start = true): Promise<Fixture> {
        const bots = new BotStore(opened.db);
        const bot = await bots.create({ name: 'CloudBot', title: 'Assistant', description: '' });
        const messages = new MessageStore(opened.db);
        const settings = new SettingsStore(opened.db);
        const access = new SetupAccess(settings);
        const token = await access.issueSetupCode();
        const cookie = await access.redeemSetupCode(token);
        const vault = new Map<string, string>();
        const connect = vi.fn<(_: string) => Promise<void>>()
            .mockResolvedValue(undefined);
        const authStatus = vi.fn<() => Promise<ClaudeAuthStatus>>()
            .mockResolvedValue({ isLoggedIn: false });
        const checkKey = vi.fn<(_: string) => Promise<number>>()
            .mockResolvedValue(200);
        const finished = Promise.withResolvers<{ ok: true }>();
        const session: ClaudeLoginSession = {
            signInUrl: Promise.resolve('https://claude.ai/login'),
            submitCode: vi.fn(() => {
                authStatus.mockResolvedValue({ isLoggedIn: true });
                finished.resolve({ ok: true });
            }),
            cancel: vi.fn(),
            finished: finished.promise,
        };
        const startLogin = vi.fn(() => session);
        const runner = new FakeAgentRunner([]);
        const chat = new ChatService({ botStore: bots, messageStore: messages, runner, dataDir });
        const setup = new SetupConversation({
            botId: bot.id, chat, messages, settings,
            vault: { delete: (name) => {
                vault.delete(name);
            }, has: name => vault.has(name), set: (name, value) => { vault.set(name, value); } },
            checkKey, connect, authStatus, startLogin,
        });
        const app = createApp({ version: 'test', access, chatService: chat, webRoot: 'missing-web-root' });

        chat.setSetup(setup);
        if (start) {
            await setup.start();
        }

        return { app, chat, setup, messages, settings, botId: bot.id, cookie: `cloudbot_session=${cookie ?? ''}`, vault, session, connect, authStatus, runner, checkKey, startLogin };
    }

    async function active(context: Fixture, kind: string): Promise<ChatMessage> {
        await vi.waitFor(async () => {
            const history = await context.chat.listMessages(context.botId);

            expect(history?.some(message => message.body.kind === kind))
                .toBe(true);
        });
        const messages = await context.chat.listMessages(context.botId);
        const matching = messages?.filter(message => message.body.kind === kind);
        const message = matching?.at(-1);

        expect(message)
            .toBeDefined();

        return message!;
    }

    async function answer(context: Fixture, messageId: string, action: string, payload: unknown, botId = context.botId): Promise<Response> {
        return context.app.request(`/api/bots/${botId}/messages/${messageId}/${action}`, {
            method: 'POST', headers: { 'Cookie': context.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
    }

    it('stores an API key only in the vault, marks answers and connects', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');
        const choiceResponse = await answer(context, choice.id, 'choice', { choiceId: 'apiKey' });
        const form = await active(context, 'secureForm');
        const response = await answer(context, form.id, 'secret', { value: SECRET });
        const stored = await context.chat.listMessages(context.botId);

        expect(choiceResponse.status)
            .toBe(200);
        expect(response.status)
            .toBe(200);
        expect(await response.text()).not.toContain(SECRET);
        expect(context.vault.get(API_KEY_NAME))
            .toBe(SECRET);
        expect(context.connect)
            .toHaveBeenCalledWith('apiKey');
        expect(context.setup.isDone())
            .toBe(true);
        expect(stored?.find(message => message.id === form.id))
            .toMatchObject({ body: { submitted: true } });
        expect(JSON.stringify(stored)).not.toContain(SECRET);
        expect(await context.settings.get('claude.setup')).not.toContain(SECRET);
    });

    it('passes the code only to the CLI and verifies sign-in before becoming ready', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        await answer(context, choice.id, 'choice', { choiceId: 'subscription' });

        const field = await active(context, 'codeField');
        const response = await answer(context, field.id, 'code', { code: CODE });

        await vi.waitFor(() => {
            expect(context.setup.isDone())
                .toBe(true);
        });
        const stored = await context.chat.listMessages(context.botId);

        expect(response.status)
            .toBe(200);
        expect(context.session.submitCode)
            .toHaveBeenCalledWith(CODE);
        expect(context.authStatus)
            .toHaveBeenCalled();
        expect(context.connect)
            .toHaveBeenCalledWith('subscription');
        expect(context.setup.isDone())
            .toBe(true);
        expect(JSON.stringify(stored)).not.toContain(CODE);
        expect(await context.settings.get('claude.setup')).not.toContain(CODE);
    });

    it('rejects unknown, wrong-bot, wrong-kind and reused messages including concurrent answers', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');
        const unknown = await answer(context, 'missing', 'choice', { choiceId: 'apiKey' });
        const wrongBot = await answer(context, choice.id, 'choice', { choiceId: 'apiKey' }, 'other');
        const wrongKind = await answer(context, choice.id, 'secret', { value: SECRET });
        const invalid = await answer(context, choice.id, 'choice', { choiceId: 'other' });
        const requests = [answer(context, choice.id, 'choice', { choiceId: 'apiKey' }), answer(context, choice.id, 'choice', { choiceId: 'apiKey' })];
        const responses = await Promise.all(requests);
        const statuses = responses.map(response => response.status);

        expect([unknown.status, wrongBot.status, wrongKind.status, invalid.status])
            .toEqual([409, 409, 409, 409]);
        expect(statuses)
            .toEqual([200, 409]);
        expect(context.vault.size)
            .toBe(0);
    });

    it('requires the owner cookie on all answer routes', async () => {
        const context = await fixture();
        const requests = ['choice', 'code', 'secret'].map(async action => context.app.request(`/api/bots/${context.botId}/messages/missing/${action}`, { method: 'POST' }));
        const responses = await Promise.all(requests);

        expect(responses.map(response => response.status))
            .toEqual([401, 401, 401]);
    });

    it('gives a scripted reminder without storing normal input or starting a turn', async () => {
        const context = await fixture();
        const response = await context.chat.sendMessage(context.botId, CODE);

        expect(response?.body.kind)
            .toBe('text');
        expect(context.chat.isTurnRunning(context.botId))
            .toBe(false);
        expect(JSON.stringify(await context.chat.listMessages(context.botId))).not.toContain(CODE);
    });

    async function restart(context: Fixture, start = true): Promise<SetupConversation> {
        context.setup.close();
        opened.close();
        opened = await openDatabase(databaseFile);
        context.messages = new MessageStore(opened.db);
        context.settings = new SettingsStore(opened.db);
        context.chat = new ChatService({ botStore: new BotStore(opened.db), messageStore: context.messages, runner: context.runner, dataDir });

        const setup = new SetupConversation({
            botId: context.botId, chat: context.chat, messages: context.messages, settings: new SettingsStore(opened.db),
            vault: { delete: (name) => {
                context.vault.delete(name);
            }, has: name => context.vault.has(name), set: (name, value) => { context.vault.set(name, value); } },
            checkKey: context.checkKey, startLogin: () => context.session, authStatus: context.authStatus, connect: context.connect,
        });
        const access = new SetupAccess(context.settings);

        context.chat.setSetup(setup);
        context.app = createApp({ version: 'test', access, chatService: context.chat, webRoot: 'missing-web-root' });
        context.setup = setup;
        if (start) {
            await setup.start();
        }

        return setup;
    }

    it('resumes a pending choice and API form without duplicating them after restart', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        await restart(context);
        expect((await active(context, 'choice')).id)
            .toBe(choice.id);
        await answer(context, choice.id, 'choice', { choiceId: 'apiKey' });

        const form = await active(context, 'secureForm');

        await restart(context);
        expect((await active(context, 'secureForm')).id)
            .toBe(form.id);
        await answer(context, form.id, 'secret', { value: SECRET });

        const setup = await restart(context);

        expect(setup.isDone())
            .toBe(true);
        expect(context.connect)
            .toHaveBeenLastCalledWith('apiKey');
    });

    it('replaces an interrupted login after restart and rejects the old code field', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        await answer(context, choice.id, 'choice', { choiceId: 'subscription' });

        const oldField = await active(context, 'codeField');

        await restart(context);

        const newField = await active(context, 'codeField');
        const response = await answer(context, oldField.id, 'code', { code: CODE });

        expect(newField.id).not.toBe(oldField.id);
        expect(response.status)
            .toBe(409);
        const stored = await context.chat.listMessages(context.botId);

        expect(stored?.find(message => message.id === oldField.id))
            .toMatchObject({ body: { submitted: true } });
    });

    it('offers a retry for CLI failure without exposing dependency errors', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        context.session.signInUrl = Promise.resolve(null);
        context.session.finished = Promise.resolve({ ok: false, reason: 'timeout' });
        await answer(context, choice.id, 'choice', { choiceId: 'subscription' });

        await vi.waitFor(async () => {
            expect((await active(context, 'choice')).id).not.toBe(choice.id);
        });
        const retry = await active(context, 'choice');

        expect(retry.id).not.toBe(choice.id);
        expect(context.setup.isDone())
            .toBe(false);
        expect(JSON.stringify(await context.chat.listMessages(context.botId)))
            .toContain('Sign-in timed out.');
    });

    it('waits for login completion and rejects an unconfirmed sign-in', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');
        const finished = Promise.withResolvers<{ ok: true }>();

        context.session.finished = finished.promise;
        context.session.submitCode = vi.fn();
        await answer(context, choice.id, 'choice', { choiceId: 'subscription' });

        const field = await active(context, 'codeField');
        const response = answer(context, field.id, 'code', { code: CODE });

        await vi.waitFor(() => {
            expect(context.session.submitCode)
                .toHaveBeenCalledWith(CODE);
        });
        expect(context.setup.isDone())
            .toBe(false);
        expect(context.connect).not.toHaveBeenCalled();
        finished.resolve({ ok: true });
        await response;
        await vi.waitFor(async () => {
            expect((await active(context, 'choice')).id).not.toBe(choice.id);
        });

        expect(context.setup.isDone())
            .toBe(false);
        expect((await active(context, 'choice')).id).not.toBe(choice.id);
        expect(JSON.stringify(await context.chat.listMessages(context.botId)))
            .toContain('Claude did not confirm sign-in.');
    });

    it('handles an idle login timeout and disables the expired field', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');
        const finished = Promise.withResolvers<{ ok: false; reason: 'timeout' }>();

        context.session.finished = finished.promise;
        await answer(context, choice.id, 'choice', { choiceId: 'subscription' });

        const field = await active(context, 'codeField');

        finished.resolve({ ok: false, reason: 'timeout' });
        await vi.waitFor(async () => {
            expect((await active(context, 'choice')).id).not.toBe(choice.id);
        });

        const stored = await context.chat.listMessages(context.botId);

        expect(stored?.find(message => message.id === field.id))
            .toMatchObject({ body: { submitted: true } });
    });

    it('hides exceptions containing codes and allows a retry', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');
        const errorLog = vi.spyOn(console, 'error');

        context.session.submitCode = vi.fn(() => {
            throw new Error(CODE);
        });
        await answer(context, choice.id, 'choice', { choiceId: 'subscription' });

        const field = await active(context, 'codeField');

        await answer(context, field.id, 'code', { code: CODE });
        expect(context.session.cancel)
            .toHaveBeenCalled();
        expect((await active(context, 'choice')).id).not.toBe(choice.id);
        expect(JSON.stringify(await context.chat.listMessages(context.botId))).not.toContain(CODE);
        expect(errorLog).not.toHaveBeenCalled();
        errorLog.mockRestore();
    });

    it('starts normal turns after setup and restores setup if the saved key disappears', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        await answer(context, choice.id, 'choice', { choiceId: 'apiKey' });

        const form = await active(context, 'secureForm');

        await answer(context, form.id, 'secret', { value: SECRET });
        await context.chat.sendMessage(context.botId, 'Hello');
        await vi.waitFor(() => {
            expect(context.runner.receivedRequests)
                .toHaveLength(1);
        });
        await vi.waitFor(() => {
            expect(context.chat.isTurnRunning(context.botId))
                .toBe(false);
        });
        context.vault.clear();

        const setup = await restart(context);

        expect(setup.isDone())
            .toBe(false);
        expect((await active(context, 'choice')).id).not.toBe(choice.id);
    });

    it.each(['', '   ', 'sk bad', 'sk\tbad', 'sk\nbad', 'sk\u0000bad', 'sk\u007fbad', 'sk\u00ffbad', 'sk\u0100bad', 'sk😀bad'])('keeps the secure form open for an invalid key %j', async (value) => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        await answer(context, choice.id, 'choice', { choiceId: 'apiKey' });

        const form = await active(context, 'secureForm');
        const response = await answer(context, form.id, 'secret', { value });

        expect(response.status)
            .toBe(value.trim().length === 0 ? 400 : 409);
        expect(context.vault.size)
            .toBe(0);
        expect((await active(context, 'secureForm')).body)
            .toMatchObject({ submitted: false });
        expect(context.checkKey).not.toHaveBeenCalled();
    });

    it('trims a key before storing and checking it', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        await answer(context, choice.id, 'choice', { choiceId: 'apiKey' });

        const form = await active(context, 'secureForm');

        await answer(context, form.id, 'secret', { value: '  ' + SECRET + '\n' });
        expect(context.vault.get(API_KEY_NAME))
            .toBe(SECRET);
        expect(context.checkKey)
            .toHaveBeenCalledOnce();
    });

    it.each([401, 403])('removes a rejected key on %i and offers a new form', async (status) => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        context.checkKey.mockResolvedValue(status);
        await answer(context, choice.id, 'choice', { choiceId: 'apiKey' });

        const form = await active(context, 'secureForm');

        await answer(context, form.id, 'secret', { value: SECRET });
        expect(context.vault.size)
            .toBe(0);
        expect(context.setup.isDone())
            .toBe(false);
        expect((await active(context, 'secureForm')).id).not.toBe(form.id);
        expect(JSON.stringify(await context.chat.listMessages(context.botId)))
            .toContain('The key was rejected.');
        expect(JSON.stringify(await context.chat.listMessages(context.botId))).not.toContain(SECRET);
    });

    it('does not store a key when checking it fails and does not expose the error', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        context.checkKey.mockRejectedValue(new Error(SECRET));
        await answer(context, choice.id, 'choice', { choiceId: 'apiKey' });

        const form = await active(context, 'secureForm');

        await answer(context, form.id, 'secret', { value: SECRET });
        expect(context.vault.get(API_KEY_NAME))
            .toBeUndefined();
        expect(context.setup.isDone())
            .toBe(false);

        const newForm = await active(context, 'secureForm');

        expect(newForm.id).not.toBe(form.id);
        expect(JSON.stringify(await context.chat.listMessages(context.botId)))
            .toContain('Could not reach Anthropic to check the key. Try again.');
        expect(JSON.stringify(await context.chat.listMessages(context.botId))).not.toContain(SECRET);
    });

    it('returns code posts and accepts later answers before the CLI finishes', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');
        const finished = Promise.withResolvers<{ ok: false; reason: 'exitedWithError' }>();

        context.session.finished = finished.promise;
        context.session.submitCode = vi.fn();
        await answer(context, choice.id, 'choice', { choiceId: 'subscription' });

        const field = await active(context, 'codeField');
        const response = await answer(context, field.id, 'code', { code: CODE });
        const duplicate = await answer(context, field.id, 'code', { code: CODE });

        expect(response.status)
            .toBe(200);
        expect(duplicate.status)
            .toBe(409);
        finished.resolve({ ok: false, reason: 'exitedWithError' });
        await vi.waitFor(async () => {
            expect((await active(context, 'choice')).id).not.toBe(choice.id);
        });
        expect((await active(context, 'codeField')).body)
            .toMatchObject({ submitted: true });
    });

    it('preserves completed subscription setup when auth status is unknown', async () => {
        const context = await fixture();

        await context.settings.set('claude.setup', JSON.stringify({ step: 'done', mode: 'subscription' }));
        context.authStatus.mockRejectedValue(new Error('status unavailable'));
        await restart(context);
        expect(context.setup.isDone())
            .toBe(true);
        expect(context.connect)
            .toHaveBeenCalledWith('subscription');
    });

    it('cancels the CLI if getting its sign-in link fails', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        context.session.signInUrl = Promise.reject(new Error(CODE));
        await answer(context, choice.id, 'choice', { choiceId: 'subscription' });
        await vi.waitFor(() => {
            expect(context.session.cancel)
                .toHaveBeenCalledOnce();
        });
        expect((await active(context, 'choice')).id).not.toBe(choice.id);
    });

    it('cancels a pending login on shutdown and ignores its late result', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');
        const finished = Promise.withResolvers<{ ok: false; reason: 'cancelled' }>();

        context.session.finished = finished.promise;
        await answer(context, choice.id, 'choice', { choiceId: 'subscription' });
        context.setup.close();
        finished.resolve({ ok: false, reason: 'cancelled' });
        await context.setup.answer(context.botId, 'missing', 'code', CODE)
            .catch(() => undefined);
        await vi.waitFor(() => {
            expect(context.session.cancel)
                .toHaveBeenCalledOnce();
        });
        expect((await active(context, 'choice')).id)
            .toBe(choice.id);
    });

    it.each(['choice', 'secret'])('reuses a %s posted before its message id was saved', async (step) => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        if (step === 'secret') {
            await answer(context, choice.id, 'choice', { choiceId: 'apiKey' });
        }

        const before = await context.chat.listMessages(context.botId);
        const state = step === 'choice' ? { step } : { step, mode: 'apiKey' };

        await context.settings.set('claude.setup', JSON.stringify(state));
        await restart(context);
        expect(await context.chat.listMessages(context.botId))
            .toEqual(before);
    });

    it('uses a local reminder in setup and a CloudBot pointer in other bots', async () => {
        const context = await fixture();
        const bots = new BotStore(opened.db);
        const other = await bots.create({ name: 'Other', title: 'Assistant', description: '' });
        const local = await context.chat.sendMessage(context.botId, SECRET);
        const remote = await context.chat.sendMessage(other.id, SECRET);

        expect(local?.body)
            .toEqual({ kind: 'text', text: 'Finish connecting Claude above to start chatting.' });
        expect(remote?.body)
            .toEqual({ kind: 'text', text: 'Finish connecting Claude in the CloudBot conversation to start chatting.' });
        expect(JSON.stringify(await context.chat.listMessages(other.id))).not.toContain(SECRET);
    });

    it('keeps the setup source free of a BOM', async () => {
        const source = await readFile(new URL('./SetupConversation.ts', import.meta.url));

        expect(source.subarray(0, 3))
            .not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    });

    it.each([502, 503])('asks again without storing the key when the check returns %i', async (status) => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        context.checkKey.mockResolvedValue(status);
        await answer(context, choice.id, 'choice', { choiceId: 'apiKey' });

        const form = await active(context, 'secureForm');

        await answer(context, form.id, 'secret', { value: SECRET });
        expect(context.vault.get(API_KEY_NAME))
            .toBeUndefined();

        const newForm = await active(context, 'secureForm');

        expect(newForm.id).not.toBe(form.id);
        expect(JSON.stringify(await context.chat.listMessages(context.botId)))
            .toContain('Could not reach Anthropic to check the key. Try again.');
    });
    it('queues old answers behind boot and keeps chat closed through connect', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        await context.settings.set('claude.setup', JSON.stringify({ step: 'done', mode: 'subscription' }));
        context.authStatus.mockResolvedValue({ isLoggedIn: true });
        await restart(context, false);

        const connected = Promise.withResolvers<undefined>();

        context.connect.mockReturnValue(connected.promise);
        const boot = context.setup.start();
        const stale = answer(context, choice.id, 'choice', { choiceId: 'apiKey' });

        await vi.waitFor(() => {
            expect(context.connect)
                .toHaveBeenCalledWith('subscription');
        });
        expect(context.setup.isDone())
            .toBe(false);
        expect((await context.chat.sendMessage(context.botId, 'Hello'))?.body)
            .toEqual({ kind: 'text', text: 'CloudBot is starting. Try again in a moment.' });
        expect(context.runner.receivedRequests)
            .toHaveLength(0);
        connected.resolve(undefined);
        await boot;
        expect((await stale).status)
            .toBe(409);
        expect(context.setup.isDone())
            .toBe(true);
        expect((await context.chat.listMessages(context.botId))?.some(message => message.body.kind === 'secureForm'))
            .toBe(false);
    });

    it('keeps the API key gate closed during boot until the proxy is connected', async () => {
        const context = await fixture(false);
        const connected = Promise.withResolvers<undefined>();

        context.vault.set(API_KEY_NAME, SECRET);
        await context.settings.set('claude.setup', '{"step":"done","mode":"apiKey"}');
        context.connect.mockReturnValue(connected.promise);

        const boot = context.setup.start();

        await vi.waitFor(() => {
            expect(context.connect)
                .toHaveBeenCalledWith('apiKey');
        });
        await context.chat.sendMessage(context.botId, 'Hello');
        expect(context.runner.receivedRequests)
            .toHaveLength(0);
        expect(context.setup.isDone())
            .toBe(false);
        connected.resolve(undefined);
        await boot;
        expect(context.setup.isDone())
            .toBe(true);
    });

    it('checks a key in memory and asks for it again after an interrupted check', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        await answer(context, choice.id, 'choice', { choiceId: 'apiKey' });

        const form = await active(context, 'secureForm');
        const checked = Promise.withResolvers<number>();

        context.checkKey.mockReturnValue(checked.promise);
        const request = answer(context, form.id, 'secret', { value: SECRET });

        await vi.waitFor(() => {
            expect(context.checkKey)
                .toHaveBeenCalledWith(SECRET);
        });
        expect(context.vault.size)
            .toBe(0);
        expect(context.connect).not.toHaveBeenCalled();
        await restart(context);
        expect(context.setup.isDone())
            .toBe(false);
        expect((await active(context, 'secureForm')).id)
            .toBe(form.id);
        checked.resolve(200);
        await request;
        expect(context.vault.size)
            .toBe(0);
    });

    it('does not launch a CLI or post after shutdown interrupts startup', async () => {
        const context = await fixture(false);
        const status = Promise.withResolvers<ClaudeAuthStatus>();
        const post = vi.spyOn(context.chat, 'postSetupMessage');

        await context.settings.set('claude.setup', '{"step":"login","mode":"subscription"}');
        context.authStatus.mockReturnValue(status.promise);
        const boot = context.setup.start();

        await vi.waitFor(() => {
            expect(context.authStatus)
                .toHaveBeenCalledOnce();
        });
        context.setup.close();
        status.resolve({ isLoggedIn: false });
        await boot;
        await context.setup.start();
        expect(post).not.toHaveBeenCalled();
        expect(context.session.cancel).not.toHaveBeenCalled();
        expect(context.startLogin).not.toHaveBeenCalled();
        expect(await context.settings.get('claude.setup'))
            .toBe('{"step":"login","mode":"subscription"}');
    });

    it('allows switching from the secure form to subscription after a restart', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        await answer(context, choice.id, 'choice', { choiceId: 'apiKey' });

        const form = await active(context, 'secureForm');

        await restart(context);
        expect((await answer(context, form.id, 'choice', { choiceId: 'subscription' })).status)
            .toBe(200);
        await active(context, 'codeField');
        expect((await context.messages.getById(form.id))?.content)
            .toMatchObject({ submitted: true });
        expect((await answer(context, form.id, 'secret', { value: SECRET })).status)
            .toBe(409);
    });

    it('returns the choice response and accepts later requests while the CLI has no link', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');
        const link = Promise.withResolvers<string | null>();

        context.session.signInUrl = link.promise;
        expect((await answer(context, choice.id, 'choice', { choiceId: 'subscription' })).status)
            .toBe(200);
        expect((await answer(context, choice.id, 'choice', { choiceId: 'apiKey' })).status)
            .toBe(409);
        link.resolve('https://claude.ai/login');
        await active(context, 'codeField');
        context.setup.close();
    });

    it('accepts CLI success when the auth status check is unavailable', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        await answer(context, choice.id, 'choice', { choiceId: 'subscription' });

        const field = await active(context, 'codeField');

        context.session.submitCode(CODE);
        context.authStatus.mockRejectedValue(new Error(CODE));
        await answer(context, field.id, 'code', { code: CODE });
        await vi.waitFor(() => {
            expect(context.setup.isDone())
                .toBe(true);
        });
    });

    it('logs fixed text and posts a setup message if startup fails', async () => {
        const context = await fixture(false);
        const log = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);

        vi.spyOn(context.settings, 'get')
            .mockRejectedValue(new Error(SECRET));
        await context.setup.start();
        expect(log)
            .toHaveBeenCalledExactlyOnceWith('Could not start Claude setup.');
        expect((await active(context, 'text')).body)
            .toEqual({ kind: 'text', text: 'Setup could not start. Check the server log.' });
        expect(context.setup.isDone())
            .toBe(false);
        log.mockRestore();
    });

    it.each([true, false])('retires the sign-in link when login ends with success %s', async (ok) => {
        const context = await fixture();
        const choice = await active(context, 'choice');
        const finished = Promise.withResolvers<{ ok: true } | { ok: false; reason: 'timeout' }>();

        context.session.finished = finished.promise;
        await answer(context, choice.id, 'choice', { choiceId: 'subscription' });

        const link = await active(context, 'link');

        context.authStatus.mockResolvedValue({ isLoggedIn: true });
        finished.resolve(ok ? { ok: true } : { ok: false, reason: 'timeout' });
        await vi.waitFor(async () => {
            expect((await context.messages.getById(link.id))?.content)
                .toEqual({ kind: 'text', text: 'Sign-in link closed.' });
        });
    });
    it('keeps chat closed when reconnecting saved setup fails', async () => {
        const context = await fixture(false);
        const log = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);

        context.vault.set(API_KEY_NAME, SECRET);
        await context.settings.set('claude.setup', '{"step":"done","mode":"apiKey"}');
        context.connect.mockRejectedValue(new Error(SECRET));
        await context.setup.start();
        expect(context.setup.isDone())
            .toBe(false);
        expect((await active(context, 'text')).body)
            .toEqual({ kind: 'text', text: 'Setup could not start. Check the server log.' });
        expect(log)
            .toHaveBeenCalledExactlyOnceWith('Could not start Claude setup.');

        // A fresh choice is offered, so setup can go on without another restart.
        const choice = await active(context, 'choice');

        await answer(context, choice.id, 'choice', { choiceId: 'apiKey' });
        expect((await active(context, 'secureForm')).body.kind)
            .toBe('secureForm');
        log.mockRestore();
    });
    it('holds an old question answer in the queue while boot checks auth', async () => {
        const context = await fixture();
        const choice = await active(context, 'choice');

        await context.settings.set('claude.setup', JSON.stringify({ step: 'choice', mode: 'subscription', messageId: choice.id }));
        await restart(context, false);

        const status = Promise.withResolvers<ClaudeAuthStatus>();

        context.authStatus.mockReturnValue(status.promise);
        const boot = context.setup.start();

        await vi.waitFor(() => {
            expect(context.authStatus)
                .toHaveBeenCalledOnce();
        });

        const request = answer(context, choice.id, 'choice', { choiceId: 'apiKey' });

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        expect((await context.messages.getById(choice.id))?.content)
            .not.toHaveProperty('chosenId');
        status.resolve({ isLoggedIn: false });
        await boot;
        expect((await request).status)
            .toBe(200);
        expect((await context.chat.listMessages(context.botId))?.filter(message => message.body.kind === 'secureForm'))
            .toHaveLength(1);
    });
});
