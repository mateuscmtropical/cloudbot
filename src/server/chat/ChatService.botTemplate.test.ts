import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner } from '../agent/AgentRunner.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { RoutineStore } from '../store/RoutineStore.ts';
import { RuleStore } from '../store/RuleStore.ts';
import type { FileBody } from '../../shared/chatTypes.ts';
import { ChatService } from './ChatService.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

// The template tests never start a turn, so the runner is never asked for an answer.
class IdleRunner implements AgentRunner {
    runTurn(): AsyncIterable<AgentEvent> {
        return (async function* idle(): AsyncGenerator<AgentEvent> {
            await Promise.resolve();
            yield { type: 'turn_finished' };
        })();
    }
}

const TEN_MINUTES_MS = 10 * 60 * 1000;

function templateText(fields: Record<string, unknown>): string {
    return JSON.stringify({ cloudbotTemplate: 1, name: 'Evil', title: 'Helper', description: 'Be brief.', ...fields });
}

describe('ChatService bot templates', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;
    let ruleStore: RuleStore;
    let routineStore: RoutineStore;
    let service: ChatService;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-template-chat-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
        ruleStore = new RuleStore(opened.db);
        routineStore = new RoutineStore(opened.db);
        service = new ChatService({ botStore, messageStore, runner: new IdleRunner(), dataDir, ruleStore, routineStore });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    // Reads the file of the latest shared file message of the bot.
    async function readSharedFile(botId: string): Promise<string> {
        const messages = await messageStore.listByBot(botId, { limit: 5 });
        const fileMessage = messages.find(message => message.kind === 'file');
        const body = fileMessage?.content as FileBody;

        return readFile(join(service.shareDirFor(botId), body.fileId), 'utf8');
    }

    // Puts a file into the uploads folder of the bot, the way an owner attachment arrives in its chat.
    async function attachToChat(botId: string, text: string, fileName: string): Promise<string> {
        const uploadDir = service.uploadDirFor(botId);
        const attachedPath = join(uploadDir, fileName);

        await mkdir(uploadDir, { recursive: true });
        await writeFile(attachedPath, text);

        return attachedPath;
    }

    async function createAna(): Promise<string> {
        const ana = await botStore.create({ name: 'Ana', title: 'Mail helper', description: 'Sorts my mail each morning.' });

        await botStore.updateMascot(ana.id, { color: 'red', shape: 'wide' });
        await botStore.setSessionId(ana.id, 'sess-SECRET-123');
        await ruleStore.add(ana.id, { kind: 'block', text: 'No purchases.', blockedTools: [] });
        await ruleStore.add(ana.id, { kind: 'block', text: 'No shell.', blockedTools: ['Bash'] });
        await routineStore.add(ana.id, { name: 'Morning sort', prompt: 'Sort the inbox.', schedule: { kind: 'daily', hour: 7, minute: 0 } });

        return ana.id;
    }

    it('exports a bot and imports the file to a new bot with the same fields', async () => {
        const anaId = await createAna();

        await service.exportBotFromTool(anaId);
        const attachedPath = await attachToChat(anaId, await readSharedFile(anaId), 'ana-template.json');

        const card = await service.describeBotImport(anaId, { path: attachedPath });

        expect(card)
            .toMatchObject({ decision: 'ask' });
        expect(card.decision === 'ask' ? card.detail : '')
            .toContain('- Block: "No purchases."');

        await service.importBotFromTool(anaId, attachedPath);

        const copies = (await botStore.list()).filter(bot => bot.name === 'Ana' && bot.id !== anaId);

        expect(copies)
            .toHaveLength(1);
        const copyId = copies[0]?.id ?? '';

        expect(copies[0])
            .toMatchObject({ title: 'Mail helper', description: 'Sorts my mail each morning.', mascotColor: 'red', mascotShape: 'wide' });
        expect(await ruleStore.list(copyId))
            .toMatchObject([{ kind: 'block', text: 'No purchases.', blockedTools: [] }, { kind: 'block', text: 'No shell.', blockedTools: ['Bash'] }]);
        expect(await routineStore.list(copyId))
            .toMatchObject([{ name: 'Morning sort', isEnabled: false }]);
    });

    it('exports and imports a bot with an empty description', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Mail helper', description: '' });

        await service.exportBotFromTool(bot.id);
        const exportedText = await readSharedFile(bot.id);
        const attachedPath = await attachToChat(bot.id, exportedText, 'ana-template.json');

        expect(JSON.parse(exportedText) as Record<string, unknown>)
            .toMatchObject({ description: '' });
        await service.describeBotImport(bot.id, { path: attachedPath });
        await service.importBotFromTool(bot.id, attachedPath);

        const copy = (await botStore.list()).find(item => item.name === 'Ana' && item.id !== bot.id);

        expect(copy?.description)
            .toBe('');
    });

    it('leaves the session, secrets, webhook addresses and learned memory of the bot out of the file', async () => {
        const anaId = await createAna();
        const workspace = service.workspaceFor(anaId);

        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, 'MEMORY.md'), 'LEARNED-MEMORY-XYZ owner prefers short replies.');

        await service.exportBotFromTool(anaId);
        const exportedText = await readSharedFile(anaId);

        expect(exportedText)
            .not.toContain('sess-SECRET-123');
        expect(exportedText)
            .not.toContain('webhook');
        expect(exportedText)
            .not.toContain('LEARNED-MEMORY-XYZ');
        const written = JSON.parse(exportedText) as Record<string, unknown>;

        expect(Object.keys(written))
            .not.toContain('memory');
    });

    it('refuses to import a file the owner was not shown', async () => {
        const anaId = await createAna();

        await service.exportBotFromTool(anaId);
        const attachedPath = await attachToChat(anaId, await readSharedFile(anaId), 'ana-template.json');

        await expect(service.importBotFromTool(anaId, attachedPath))
            .rejects
            .toThrow('The template file changed after the owner was shown it. Attach it again and ask.');
    });

    it('refuses to import a file that changed after the owner was shown it', async () => {
        const anaId = await createAna();

        await service.exportBotFromTool(anaId);
        const attachedPath = await attachToChat(anaId, await readSharedFile(anaId), 'ana-template.json');

        await service.describeBotImport(anaId, { path: attachedPath });
        await writeFile(attachedPath, templateText({ name: 'Evil' }));

        await expect(service.importBotFromTool(anaId, attachedPath))
            .rejects
            .toThrow('The template file changed after the owner was shown it');
        expect((await botStore.list()).some(bot => bot.name === 'Evil'))
            .toBe(false);
    });

    it('lets one card be used once, so a second import of the same card is refused', async () => {
        const anaId = await createAna();

        await service.exportBotFromTool(anaId);
        const attachedPath = await attachToChat(anaId, await readSharedFile(anaId), 'ana-template.json');

        await service.describeBotImport(anaId, { path: attachedPath });
        await service.importBotFromTool(anaId, attachedPath);

        await expect(service.importBotFromTool(anaId, attachedPath))
            .rejects
            .toThrow('The template file changed after the owner was shown it');
    });

    it('drops the older card when a newer card for the same path is shown, so the older file cannot import', async () => {
        const anaId = await createAna();
        const firstText = templateText({ name: 'First', description: 'First version.' });
        const secondText = templateText({ name: 'Second', description: 'Second version.' });
        const attachedPath = await attachToChat(anaId, firstText, 'card.json');

        await service.describeBotImport(anaId, { path: attachedPath });
        await writeFile(attachedPath, secondText);
        await service.describeBotImport(anaId, { path: attachedPath });
        await writeFile(attachedPath, firstText);

        await expect(service.importBotFromTool(anaId, attachedPath))
            .rejects
            .toThrow('The template file changed after the owner was shown it');
        expect((await botStore.list()).some(bot => bot.name === 'First'))
            .toBe(false);
    });
    it('refuses an import whose card is older than ten minutes', async () => {
        const anaId = await createAna();
        const attachedPath = await attachToChat(anaId, templateText({ name: 'Late' }), 'late.json');
        const shownAt = Date.now();

        vi.spyOn(Date, 'now')
            .mockReturnValue(shownAt);
        await service.describeBotImport(anaId, { path: attachedPath });
        vi.spyOn(Date, 'now')
            .mockReturnValue(shownAt + TEN_MINUTES_MS + 1);

        await expect(service.importBotFromTool(anaId, attachedPath))
            .rejects
            .toThrow('The template file changed after the owner was shown it');
        expect((await botStore.list()).some(bot => bot.name === 'Late'))
            .toBe(false);
    });

    it('denies the import card for a file attached in another bot\'s chat', async () => {
        const anaId = await createAna();
        const bobId = (await botStore.create({ name: 'Bob', title: 'Helper', description: 'Other bot.' })).id;
        const bobPath = await attachToChat(bobId, templateText({ name: 'Ana' }), 'ana-template.json');
        const card = await service.describeBotImport(anaId, { path: bobPath });

        expect(card)
            .toEqual({ decision: 'deny', reason: 'Only a file attached in this chat can be imported.' });
    });

    it('denies the import card for a file outside the chat attachments', async () => {
        const anaId = await createAna();
        const outsidePath = join(dataDir, 'ana-template.json');

        await writeFile(outsidePath, templateText({ name: 'Ana' }));
        const card = await service.describeBotImport(anaId, { path: outsidePath });

        expect(card)
            .toEqual({ decision: 'deny', reason: 'Only a file attached in this chat can be imported.' });
    });

    it('denies the import card for a file that is not a template', async () => {
        const anaId = await createAna();
        const notePath = await attachToChat(anaId, '{"hello": "world"}', 'note.json');
        const card = await service.describeBotImport(anaId, { path: notePath });

        expect(card.decision)
            .toBe('deny');
    });

    it('shows a text instruction file as an import draft and creates no CloudBot rules or routines', async () => {
        const anaId = await createAna();
        const sourceText = '## Mail helper\n\nSummarize new mail. API key: abc123-secret-value';
        const attachedPath = await attachToChat(anaId, sourceText, 'instructions.md');
        const card = await service.describeBotImport(anaId, { path: attachedPath });

        expect(card)
            .toMatchObject({ decision: 'ask', summary: 'Create a bot from imported instructions.' });
        expect(card.decision === 'ask' ? card.detail : '')
            .toContain('## Mail helper');
        expect(card.decision === 'ask' ? card.detail : '')
            .toContain('credentials, approval settings and routines are not imported');
        expect(card.decision === 'ask' ? card.detail : '')
            .not.toContain('abc123-secret-value');

        await service.importBotFromTool(anaId, attachedPath);

        const importedBot = (await botStore.list()).find(bot => bot.name === 'Imported bot');

        expect(importedBot)
            .toMatchObject({ title: 'Imported assistant', description: '' });
        expect(await ruleStore.list(importedBot?.id ?? ''))
            .toEqual([]);
        expect(await routineStore.list(importedBot?.id ?? ''))
            .toEqual([]);
        const memory = await readFile(join(service.workspaceFor(importedBot?.id ?? ''), 'MEMORY.md'), 'utf8');

        expect(memory)
            .toContain('Summarize new mail. API key: [redacted]');
        expect(memory)
            .not.toContain('abc123-secret-value');
    });

    it('imports a pasted draft as profile and memory without adding permissions or routines', async () => {
        const imported = await service.createBotFromImportTool({
            name: 'Pasted helper',
            title: 'Inbox organizer',
            description: 'Summarize messages.',
            instructions: 'Summarize mail. Never send it.',
        });
        const importedBot = (await botStore.list()).find(bot => bot.name === imported.name);

        expect(importedBot)
            .toMatchObject({ title: 'Inbox organizer', description: 'Summarize messages.' });
        expect(await ruleStore.list(importedBot?.id ?? ''))
            .toEqual([]);
        expect(await routineStore.list(importedBot?.id ?? ''))
            .toEqual([]);
        const memory = await readFile(join(service.workspaceFor(importedBot?.id ?? ''), 'MEMORY.md'), 'utf8');

        expect(memory)
            .toContain('Summarize mail. Never send it.');
    });

    it('refuses to import an external file changed after its draft card was shown', async () => {
        const anaId = await createAna();
        const attachedPath = await attachToChat(anaId, 'First instruction.', 'instructions.txt');

        await service.describeBotImport(anaId, { path: attachedPath });
        await writeFile(attachedPath, 'Changed instruction.');

        await expect(service.importBotFromTool(anaId, attachedPath))
            .rejects
            .toThrow('The imported file changed after the owner was shown its draft. Attach it again and ask.');
        expect((await botStore.list()).some(bot => bot.name === 'Imported bot'))
            .toBe(false);
    });

    it('refuses the import and removes the new bot when this CloudBot has no rule store', async () => {
        const anaId = await createAna();
        const withoutRules = new ChatService({ botStore, messageStore, runner: new IdleRunner(), dataDir, routineStore });
        const attachedPath = await attachToChat(anaId, templateText({ name: 'Evil', rules: [{ kind: 'allow', text: 'Anything.', blockedTools: [] }] }), 'evil.json');

        await withoutRules.describeBotImport(anaId, { path: attachedPath });

        await expect(withoutRules.importBotFromTool(anaId, attachedPath))
            .rejects
            .toThrow('This CloudBot cannot save rules, so the template was not imported.');
        expect((await botStore.list()).some(bot => bot.name === 'Evil'))
            .toBe(false);
    });

    it('adds the rules of an imported template in file order', async () => {
        const anaId = await createAna();
        const rules = ['First rule.', 'Second rule.', 'Third rule.'].map(text => ({ kind: 'allow', text, blockedTools: [] }));
        const attachedPath = await attachToChat(anaId, templateText({ name: 'Ordered', rules }), 'ordered.json');

        await service.describeBotImport(anaId, { path: attachedPath });
        await service.importBotFromTool(anaId, attachedPath);

        const copy = (await botStore.list()).find(item => item.name === 'Ordered');

        expect((await ruleStore.list(copy?.id ?? '')).map(rule => rule.text))
            .toEqual(['First rule.', 'Second rule.', 'Third rule.']);
    });
});
