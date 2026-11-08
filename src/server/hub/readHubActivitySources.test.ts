import { describe, expect, it } from 'vitest';

import { readHubActivitySources } from './readHubActivitySources.ts';
import type { HubActivitySourceOptions } from './readHubActivitySources.ts';

describe('readHubActivitySources', () => {
    it('reads the activity sources across every bot', async () => {
        const options: HubActivitySourceOptions = {
            botStore: {
                list: () => Promise.resolve([{ id: 'one' }, { id: 'two' }]),
            },
            chatService: {
                hasConfiguredEmailAccount: (botId: string) => Promise.resolve(botId === 'two'),
                isBotBusy: botId => botId === 'one',
                isTelegramConnected: botId => botId === 'two',
                isDiscordConnected: botId => botId === 'one',
            },
            routineStore: {
                list: (botId: string) => Promise.resolve(botId === 'two' ? [{ isEnabled: true }] : [{ isEnabled: false }]),
            },
            watchStore: {
                list: (botId: string) => Promise.resolve(botId === 'one' ? [{ id: 'watch' }] : []),
            },
            webhookStore: {
                list: (botId: string) => Promise.resolve(botId === 'two' ? [{ id: 'webhook' }] : []),
            },
            whatsappStore: {
                list: () => Promise.resolve([{ botId: 'one' }]),
            },
            isReady: () => true,
        };

        await expect(readHubActivitySources(options))
            .resolves
            .toEqual({
                hasActiveTurn: true,
                hasEnabledRoutine: true,
                hasEnabledWatch: true,
                hasWebhook: true,
                hasWhatsAppConnection: true,
                hasTelegramConnection: true,
                hasDiscordConnection: true,
                hasEmailAccount: true,
                hasAgentProgram: false,
                isLoginOrSetupInProgress: false,
                hasAppSignIn: false,
                hasAppTrigger: false,
            });
    });

    it('counts a program the bot started as activity', async () => {
        const options: HubActivitySourceOptions = { hasAgentProgram: () => Promise.resolve(true), isReady: () => true };

        const sources = await readHubActivitySources(options);

        expect(sources.hasAgentProgram)
            .toBe(true);
    });

    it('counts an app trigger only while it is enabled', async () => {
        const withTriggers = (triggers: { isEnabled: boolean }[]): HubActivitySourceOptions => ({ triggerStore: { list: () => Promise.resolve(triggers) }, botStore: { list: () => Promise.resolve([{ id: 'one' }]) }, isReady: () => true });

        expect((await readHubActivitySources(withTriggers([{ isEnabled: false }]))).hasAppTrigger)
            .toBe(false);
        expect((await readHubActivitySources(withTriggers([{ isEnabled: false }, { isEnabled: true }]))).hasAppTrigger)
            .toBe(true);
    });

    it('counts setup as activity and handles absent optional stores', async () => {
        const options: HubActivitySourceOptions = { isReady: () => false };

        await expect(readHubActivitySources(options))
            .resolves
            .toEqual({
                hasActiveTurn: false,
                hasEnabledRoutine: false,
                hasEnabledWatch: false,
                hasWebhook: false,
                hasWhatsAppConnection: false,
                hasTelegramConnection: false,
                hasDiscordConnection: false,
                hasEmailAccount: false,
                hasAgentProgram: false,
                isLoginOrSetupInProgress: true,
                hasAppSignIn: false,
                hasAppTrigger: false,
            });
    });
});
