import { describe, expect, it } from 'vitest';

import { createBotExportTool, createBotImportTextTool, createBotImportTool } from './createBotTemplateTools.ts';
import type { BotImportDraft } from './externalBotImport.ts';

interface ToolResult {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;

function handlerOf(tool: unknown): ToolHandler {
    return (tool as { handler: ToolHandler }).handler;
}

describe('createBotTemplateTools', () => {
    it('tells the bot the export is shared in the chat', async () => {
        const handler = handlerOf(createBotExportTool(() => Promise.resolve({ name: 'Ana' })));
        const reply = await handler({}, undefined);

        expect(reply)
            .toEqual({ content: [{ type: 'text', text: 'The template of Ana is shared in the chat.' }] });
    });

    it('gives the bot the reason when the export fails, as an error', async () => {
        const handler = handlerOf(createBotExportTool(() => Promise.reject(new Error('This bot cannot be exported.'))));
        const reply = await handler({}, undefined);

        expect(reply)
            .toEqual({ content: [{ type: 'text', text: 'This bot cannot be exported.' }], isError: true });
    });

    it('passes the path to the import and says the routines are off', async () => {
        const seenPaths: string[] = [];
        const handler = handlerOf(createBotImportTool((path) => {
            seenPaths.push(path);

            return Promise.resolve({ name: 'Ana' });
        }));
        const reply = await handler({ path: '/uploads/ana.json' }, undefined);

        expect(seenPaths)
            .toEqual(['/uploads/ana.json']);
        expect(reply.content[0]?.text)
            .toBe('Created the bot Ana from the template. Its routines are off. The owner can open it from the bot list.');
    });

    it('gives the bot the reason when the import is refused, as an error', async () => {
        const handler = handlerOf(createBotImportTool(() => Promise.reject(new Error('The template is not valid at name: Use one line.'))));
        const reply = await handler({ path: '/uploads/ana.json' }, undefined);

        expect(reply)
            .toEqual({ content: [{ type: 'text', text: 'The template is not valid at name: Use one line.' }], isError: true });
    });

    it('passes the approved pasted draft to the import handler', async () => {
        const seenDrafts: BotImportDraft[] = [];
        const handler = handlerOf(createBotImportTextTool((draft) => {
            seenDrafts.push(draft);

            return Promise.resolve({ name: draft.name });
        }));
        const draft: BotImportDraft = { name: 'Mail helper', title: 'Inbox organizer', description: 'Summarize mail.', instructions: 'Use a warm tone.' };
        const reply = await handler({ ...draft }, undefined);

        expect(seenDrafts)
            .toEqual([draft]);
        expect(reply.content[0]?.text)
            .toBe('Created the bot Mail helper from the approved imported instructions.');
    });
});
