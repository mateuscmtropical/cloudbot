import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import type { ProviderToolDependencies } from '../providers/createProviderTools.ts';
import type { ProviderId } from '../providers/providerIds.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { ChatEvent, ChatMessage } from '../../shared/chatTypes.ts';
import { ChatService } from './ChatService.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

// Every turn ends at the usage limit, as the CLI reports it.
class LimitRunner implements AgentRunner {
    readonly receivedRequests: TurnRequest[] = [];

    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        this.receivedRequests.push(request);

        return replayLimit();
    }
}

// A replay has nothing to await. The runner still needs an async iterable.
// eslint-disable-next-line @typescript-eslint/require-await
async function* replayLimit(): AsyncGenerator<AgentEvent> {
    yield { type: 'turn_error', message: 'You\'ve hit your limit', isUsageLimit: true };
}

function waitForChoiceCard(service: ChatService, botId: string): Promise<ChatMessage> {
    return new Promise((resolve) => {
        const unsubscribe = service.subscribe(botId, (event: ChatEvent) => {
            if (event.type === 'message' && event.message.body.kind === 'choice' && event.message.body.isProviderSwitch === true) {
                unsubscribe();
                resolve(event.message);
            }
        });
    });
}

describe('ChatService provider switch after a usage limit', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;
    let currentProvider: ProviderId;
    let providerTools: ProviderToolDependencies;

    function createService(connected: ProviderId[]): ChatService {
        providerTools = {
            available: ['claude', 'chatgpt', 'gemini'],
            connected: () => Promise.resolve(connected),
            providerFor: () => Promise.resolve(currentProvider),
            setProvider: vi.fn((_botId: string, provider: ProviderId) => {
                currentProvider = provider;

                return Promise.resolve();
            }),
            offerProviders: vi.fn(() => Promise.resolve()),
        };

        return new ChatService({ botStore, messageStore, runner: new LimitRunner(), dataDir, providerTools });
    }

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-switch-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
        currentProvider = 'claude';
    });

    afterEach(async () => {
        vi.useRealTimers();
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    it('offers the other connected providers and a way to keep waiting', async () => {
        vi.useFakeTimers();
        const service = createService(['claude', 'gemini']);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const cardArrived = waitForChoiceCard(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        const card = await cardArrived;

        expect(card.body)
            .toEqual({
                kind: 'choice',
                prompt: 'Claude reached its usage limit. Switch to another provider?',
                options: [{ id: 'gemini', label: 'Gemini' }, { id: 'wait', label: 'Keep waiting' }],
                isProviderSwitch: true,
            });

        service.dispose();
    });

    it('offers nothing when no other provider is connected', async () => {
        vi.useFakeTimers();
        const service = createService(['claude']);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.sendMessage(bot.id, 'Hi');
        await vi.advanceTimersByTimeAsync(0);

        const messages = (await service.listMessages(bot.id)) ?? [];

        expect(messages.some(message => message.body.kind === 'choice'))
            .toBe(false);

        service.dispose();
    });

    it('switches the provider, ends the wait and asks the owner to send the message again', async () => {
        vi.useFakeTimers();
        const service = createService(['claude', 'gemini']);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const cardArrived = waitForChoiceCard(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        const card = await cardArrived;
        const answered = await service.answerSetup(bot.id, card.id, 'choice', 'gemini');

        expect(providerTools.setProvider)
            .toHaveBeenCalledWith(bot.id, 'gemini');
        expect(answered.body)
            .toMatchObject({ kind: 'choice', chosenId: 'gemini' });

        const messages = (await service.listMessages(bot.id)) ?? [];
        const systemTexts = messages.flatMap(message => (message.role === 'system' && message.body.kind === 'text' ? [message.body.text] : []));

        expect(systemTexts)
            .toContain('From your next message this bot runs on Gemini. Send your message again.');
        expect(await service.stopTurn(bot.id))
            .toBe(false);

        service.dispose();
    });

    it('keeps the provider and the wait when the owner keeps waiting', async () => {
        vi.useFakeTimers();
        const service = createService(['claude', 'gemini']);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const cardArrived = waitForChoiceCard(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        const card = await cardArrived;
        const answered = await service.answerSetup(bot.id, card.id, 'choice', 'wait');

        expect(providerTools.setProvider)
            .not
            .toHaveBeenCalled();
        expect(answered.body)
            .toMatchObject({ chosenId: 'wait' });
        expect(await service.stopTurn(bot.id))
            .toBe(true);

        service.dispose();
    });

    it('refuses a second answer and a provider the card does not offer', async () => {
        vi.useFakeTimers();
        const service = createService(['claude', 'gemini']);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const cardArrived = waitForChoiceCard(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        const card = await cardArrived;

        await expect(service.answerSetup(bot.id, card.id, 'choice', 'chatgpt'))
            .rejects
            .toThrow('This is not an answer of this card.');

        await service.answerSetup(bot.id, card.id, 'choice', 'gemini');

        await expect(service.answerSetup(bot.id, card.id, 'choice', 'wait'))
            .rejects
            .toThrow('This question was already answered.');

        service.dispose();
    });
});
