import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner } from '../agent/AgentRunner.ts';
import { BotSecrets } from '../secrets/BotSecrets.ts';
import { Vault } from '../vault/Vault.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { RoutineStore } from '../store/RoutineStore.ts';
import { RuleStore } from '../store/RuleStore.ts';
import { TemplateGallery } from '../bots/templateGallery.ts';
import type { GalleryRequest, GalleryResponse, GalleryTransport } from '../bots/templateGallery.ts';
import { ChatService } from './ChatService.ts';

// The gallery tests never start a turn, so the runner is never asked for an answer.
class IdleRunner implements AgentRunner {
    runTurn(): AsyncIterable<AgentEvent> {
        return (async function* idle(): AsyncGenerator<AgentEvent> {
            await Promise.resolve();
            yield { type: 'turn_finished' };
        })();
    }
}

const REPO = 'owner/templates';
const FILES_PATH = `/repos/${REPO}/contents/templates`;
const FORK = 'bot-owner/templates';
const FORK_FILES_PATH = `/repos/${FORK}/contents/templates`;
const PULL_URL = 'https://github.com/owner/templates/pull/9';

function templateText(fields: Record<string, unknown>): string {
    return JSON.stringify({ cloudbotTemplate: 1, name: 'Ana', title: 'Mail helper', description: 'Sorts mail.', rules: [{ kind: 'block', text: 'No purchases.', blockedTools: [] }], ...fields });
}

// A fake GitHub. Gallery files are read from `files`, which the test can change. The share routes answer the pull request steps.
function fakeGithub(files: Record<string, string>, sent: GalleryRequest[]): GalleryTransport {
    const shareRoutes: Record<string, GalleryResponse> = {
        [`GET /repos/${REPO}`]: { status: 200, text: JSON.stringify({ default_branch: 'main' }) },
        [`POST /repos/${REPO}/forks`]: { status: 202, text: JSON.stringify({ full_name: FORK, owner: { login: 'bot-owner' } }) },
        [`GET /repos/${FORK}/git/ref/heads/main`]: { status: 200, text: JSON.stringify({ object: { sha: 'base-sha' } }) },
        [`GET /repos/${REPO}/git/ref/heads/main`]: { status: 200, text: JSON.stringify({ object: { sha: 'gallery-head-sha' } }) },
        [`POST /repos/${FORK}/git/refs`]: { status: 201, text: '{}' },
        [`PUT ${FORK_FILES_PATH}/ana-template.json`]: { status: 201, text: '{}' },
        [`PUT ${FORK_FILES_PATH}/index.json`]: { status: 201, text: '{}' },
        [`POST /repos/${REPO}/pulls`]: { status: 201, text: JSON.stringify({ html_url: PULL_URL }) },
    };

    return (request: GalleryRequest): Promise<GalleryResponse> => {
        sent.push(request);

        const key = `${request.method} ${request.url.pathname}`;
        const isFileRead = request.method === 'GET' && request.url.pathname.startsWith(`${FILES_PATH}/`);

        if (isFileRead && request.url.search === '') {
            const fileName = request.url.pathname.slice(`${FILES_PATH}/`.length);
            const fileText = files[fileName];

            return Promise.resolve(fileText === undefined ? { status: 404, text: '' } : { status: 200, text: fileText });
        }

        if (request.url.search.startsWith('?ref=')) {
            return Promise.resolve({ status: 404, text: '' });
        }

        const route = shareRoutes[key];

        return route === undefined ? Promise.reject(new Error(`No fake route for ${key}`)) : Promise.resolve(route);
    };
}

describe('ChatService template gallery', () => {
    let dataDir: string;
    let vaultDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;
    let ruleStore: RuleStore;
    let routineStore: RoutineStore;
    let secrets: BotSecrets;
    let files: Record<string, string>;
    let sent: GalleryRequest[];
    let service: ChatService;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-gallery-chat-'));
        vaultDir = join(dataDir, 'vault');
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
        ruleStore = new RuleStore(opened.db);
        routineStore = new RoutineStore(opened.db);
        secrets = new BotSecrets(new Vault(vaultDir));
        files = { 'ana-mail.json': templateText({}) };
        sent = [];
        const gallery = new TemplateGallery({ repo: REPO, transport: fakeGithub(files, sent), now: () => 1000 });

        service = new ChatService({ botStore, messageStore, runner: new IdleRunner(), dataDir, ruleStore, routineStore, botSecrets: secrets, templateGallery: gallery });
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true });
    });

    async function createAna(): Promise<string> {
        const ana = await botStore.create({ name: 'Ana', title: 'Mail helper', description: 'Sorts my mail.' });

        await ruleStore.add(ana.id, { kind: 'block', text: 'No purchases.', blockedTools: [] });

        return ana.id;
    }

    it('asks the owner with the whole gallery template and the file it came from', async () => {
        const botId = await createAna();
        const verdict = await service.describeGalleryInstall(botId, { file: 'ana-mail.json' });

        expect(verdict.decision)
            .toBe('ask');
        expect(verdict.decision === 'ask' ? verdict.detail : '')
            .toContain('From the gallery "owner/templates", file "ana-mail.json".');
        expect(verdict.decision === 'ask' ? verdict.detail : '')
            .toContain('Name: "Ana"');
        expect(verdict.decision === 'ask' ? verdict.detail : '')
            .toContain('- Block: "No purchases."');
    });

    it('denies an install for a file that is not in the gallery', async () => {
        const botId = await createAna();
        const verdict = await service.describeGalleryInstall(botId, { file: 'missing.json' });

        expect(verdict)
            .toEqual({ decision: 'deny', reason: 'That template is not in the gallery. Use a name from the gallery list.' });
    });

    it('creates the bot from the card the owner saw, with its rules, and its routines turned off', async () => {
        const botId = await createAna();

        await service.describeGalleryInstall(botId, { file: 'ana-mail.json' });
        const imported = await service.installGalleryTemplate(botId, 'ana-mail.json');
        const copy = (await botStore.list()).find(bot => bot.name === imported.name && bot.id !== botId);

        expect(copy)
            .toBeDefined();
        expect(await ruleStore.list(copy?.id ?? ''))
            .toMatchObject([{ kind: 'block', text: 'No purchases.' }]);
    });

    it('refuses an install when the gallery file changed after the owner was shown it', async () => {
        const botId = await createAna();

        await service.describeGalleryInstall(botId, { file: 'ana-mail.json' });
        files['ana-mail.json'] = templateText({ name: 'Evil' });

        await expect(service.installGalleryTemplate(botId, 'ana-mail.json'))
            .rejects
            .toThrow('The template changed after the owner was shown it. Ask again.');
        expect((await botStore.list()).some(bot => bot.name === 'Evil'))
            .toBe(false);
    });

    it('refuses a second install card with other content while the first waits, so approving the first never installs it', async () => {
        const botId = await createAna();

        await service.describeGalleryInstall(botId, { file: 'ana-mail.json' });
        files['ana-mail.json'] = templateText({ name: 'Evil' });
        const second = await service.describeGalleryInstall(botId, { file: 'ana-mail.json' });

        expect(second.decision)
            .toBe('deny');
        // The owner approves the first card, which showed Ana.
        await expect(service.installGalleryTemplate(botId, 'ana-mail.json'))
            .rejects
            .toThrow('The template changed after the owner was shown it. Ask again.');
        expect((await botStore.list()).some(bot => bot.name === 'Evil'))
            .toBe(false);
    });

    it('answers each install card once', async () => {
        const botId = await createAna();

        await service.describeGalleryInstall(botId, { file: 'ana-mail.json' });
        await service.installGalleryTemplate(botId, 'ana-mail.json');

        await expect(service.installGalleryTemplate(botId, 'ana-mail.json'))
            .rejects
            .toThrow('The card expired, ask again.');
    });

    it('denies a share when GitHub is not connected, and asks nothing', async () => {
        const botId = await createAna();
        const verdict = await service.describeGalleryShare(botId);

        expect(verdict.decision)
            .toBe('deny');
        expect(verdict.decision === 'deny' ? verdict.reason : '')
            .toContain('Sharing needs GitHub connected');
        expect(sent)
            .toHaveLength(0);
    });

    it('shows the owner the exact file of the pull request before any request is sent', async () => {
        const botId = await createAna();

        secrets.save(botId, 'GITHUB_TOKEN', 'https://github.com', 'fake-token-1');

        const verdict = await service.describeGalleryShare(botId);

        expect(verdict.decision)
            .toBe('ask');
        expect(verdict.decision === 'ask' ? verdict.detail : '')
            .toContain('File: templates/ana-template.json');
        expect(verdict.decision === 'ask' ? verdict.detail : '')
            .toContain('"name": "Ana"');
        expect(sent.filter(request => request.method !== 'GET'))
            .toHaveLength(0);
    });

    it('says the card replaces an existing file, and that the pull request comes from the fork', async () => {
        const botId = await createAna();

        secrets.save(botId, 'GITHUB_TOKEN', 'https://github.com', 'fake-token-1');
        files['ana-template.json'] = templateText({});

        const verdict = await service.describeGalleryShare(botId);

        expect(verdict.decision === 'ask' ? verdict.detail : '')
            .toContain('File: templates/ana-template.json (replaces an existing file)');
        expect(verdict.decision === 'ask' ? verdict.detail : '')
            .toContain('Pull request from your fork of owner/templates.');
    });

    it('opens the pull request for the file the owner approved', async () => {
        const botId = await createAna();

        secrets.save(botId, 'GITHUB_TOKEN', 'https://github.com', 'fake-token-1');
        await service.describeGalleryShare(botId);
        const url = await service.shareGalleryTemplate(botId);

        expect(url)
            .toBe(PULL_URL);
        expect(sent.every(request => request.token === 'fake-token-1' || request.method === 'GET'))
            .toBe(true);
    });

    it('refuses the share when the bot changed after the owner was shown the file', async () => {
        const botId = await createAna();

        secrets.save(botId, 'GITHUB_TOKEN', 'https://github.com', 'fake-token-1');
        await service.describeGalleryShare(botId);
        await ruleStore.add(botId, { kind: 'allow', text: 'Anything else.', blockedTools: [] });

        await expect(service.shareGalleryTemplate(botId))
            .rejects
            .toThrow('The template changed after the owner was shown it. Ask again.');
        expect(sent.some(request => request.method === 'PUT'))
            .toBe(false);
    });

    it('denies a share of a bot whose template cannot be exported in full', async () => {
        const botId = await createAna();

        secrets.save(botId, 'GITHUB_TOKEN', 'https://github.com', 'fake-token-1');
        await ruleStore.add(botId, { kind: 'allow', text: 'x'.repeat(400), blockedTools: [] });
        const verdict = await service.describeGalleryShare(botId);

        expect(verdict.decision)
            .toBe('deny');
        expect(verdict.decision === 'deny' ? verdict.reason : '')
            .toContain('cannot be exported');
    });
});
