import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import type { BrowserControl } from '../desktop/BrowserControl.ts';
import { CdpConnection } from '../desktop/CdpConnection.ts';
import { ScreenHolder } from '../desktop/ScreenHolder.ts';
import { createFakeSocketFactory } from '../desktop/testCdp.ts';
import type { FakeCdpSocket } from '../desktop/testCdp.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { ChatService } from './ChatService.ts';

// A browser whose page connection is a fake socket. The test plays the page's reports on it.
function fakeBrowser(sockets: FakeCdpSocket[]): BrowserControl {
    const { factory, sockets: made } = createFakeSocketFactory(() => ({ result: {} }));

    return {
        connectPage: async (): Promise<CdpConnection> => {
            const connection = await CdpConnection.open('ws://page', factory);
            const socket = made.at(-1);

            if (socket !== undefined) {
                sockets.push(socket);
            }

            return connection;
        },
    } as unknown as BrowserControl;
}

function reportStep(socket: FakeCdpSocket | undefined, step: unknown): void {
    const bindingCall = socket?.sent.find(call => call.method === 'Runtime.addBinding');
    const name = String(bindingCall?.params.name);

    socket?.emit('message', { data: JSON.stringify({ method: 'Runtime.bindingCalled', params: { name, payload: JSON.stringify(step) } }) });
}

describe('ChatService screen recording', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;
    let screen: ScreenHolder;
    let sockets: FakeCdpSocket[];
    let service: ChatService;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-recording-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
        screen = new ScreenHolder();
        sockets = [];
        service = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, screen, browser: fakeBrowser(sockets) });
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true });
    });

    it('hands the screen to the owner, records until it is given back, then gives the bot the steps', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.startScreenRecording(bot.id, 'file an expense');
        const note = ((await service.listMessages(bot.id)) ?? []).at(-1);
        const whileRecording = service.readScreenRecording(bot.id);

        reportStep(sockets[0], { kind: 'click', target: 'New expense' });
        reportStep(sockets[0], { kind: 'secret', field: 'Password' });
        screen.giveToBot();
        reportStep(sockets[0], { kind: 'click', target: 'After the end' });

        expect(screen.holder)
            .toBe('bot');
        expect(JSON.stringify(note?.body))
            .toContain('file an expense');
        expect(JSON.stringify(note?.body))
            .toContain('never record what you type into a password');
        expect(whileRecording)
            .toContain('still running');
        expect(service.readScreenRecording(bot.id))
            .toContain('1. Clicked "New expense"\n2. Typed a secret into "Password" (not recorded, ask for the saved secret)');
        expect(service.readScreenRecording(bot.id))
            .not.toContain('After the end');
        expect(sockets[0]?.isClosed)
            .toBe(true);
    });

    it('refuses a second recording while the owner has the screen, and keeps the first one going', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        await service.startScreenRecording(ana.id, 'file an expense');

        await expect(service.startScreenRecording(ben.id, 'something else'))
            .rejects.toThrow('already has the screen');
        expect(sockets)
            .toHaveLength(1);
        expect(sockets[0]?.isClosed)
            .toBe(false);
    });

    it('starts only one of two recordings that begin at the same moment, and leaves no recorder running', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        const results = await Promise.allSettled([
            service.startScreenRecording(ana.id, 'file an expense'),
            service.startScreenRecording(ben.id, 'something else'),
        ]);

        expect(results.map(result => result.status))
            .toEqual(['fulfilled', 'rejected']);
        expect(sockets)
            .toHaveLength(1);
    });

    it('refuses another bot\'s request for the screen while a recording runs', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        await service.startScreenRecording(ana.id, 'file an expense');

        await expect(service.requestScreen(ben.id, 'A check I cannot pass.'))
            .rejects.toThrow('recorded for another bot');
    });

    it('drops the recording when another bot took the screen while the recorder started', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const startPromise = service.startScreenRecording(ana.id, 'file an expense');

        // The owner takes the screen for something else before the recorder is ready.
        screen.giveToPerson();

        await expect(startPromise)
            .rejects.toThrow('already has the screen');
        expect(sockets[0]?.isClosed)
            .toBe(true);
        expect(service.readScreenRecording(ana.id))
            .toContain('There is no recording');
    });

    it('says there is no recording before one was made', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        expect(service.readScreenRecording(bot.id))
            .toContain('There is no recording');
    });

    it('ends the recording of a bot that is deleted', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        // The last bot cannot be deleted, so a second one stays.
        await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        await service.startScreenRecording(bot.id, 'file an expense');
        const outcome = await service.deleteBot(bot.id);

        expect(outcome)
            .toBe('deleted');

        expect(sockets[0]?.isClosed)
            .toBe(true);
    });
});
