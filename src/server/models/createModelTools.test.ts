import { describe, expect, it } from 'vitest';

import type { ModelStore } from '../store/ModelStore.ts';
import type { ModelChoices } from './modelChoices.ts';
import { createModelTools } from './createModelTools.ts';
import type { ModelToolResult } from './createModelTools.ts';
import type { CloudbotTool } from '../agent/createProfileToolServer.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ModelToolResult>;

const STORED: ModelChoices = { chat: 'haiku', routines: null, review: null, browsing: null, documents: null };

// Keeps the choices in memory, so the tool is tested without the database.
interface FakeStore extends Pick<ModelStore, 'get' | 'set'> {
    // The last choices saved, or undefined when nothing was saved.
    saved: () => ModelChoices | undefined;
}

function createFakeStore(initial: ModelChoices): FakeStore {
    let current: ModelChoices | undefined;

    return {
        get: () => Promise.resolve(initial),
        set: (_botId: string, choices: ModelChoices) => {
            current = choices;

            return Promise.resolve();
        },
        saved: () => current,
    };
}

function findHandler(tools: CloudbotTool[]): ToolHandler {
    const found = (tools as unknown as { name: string; handler: unknown }[]).find(candidate => candidate.name === 'models_set');

    if (found === undefined) {
        throw new Error('No models_set tool');
    }

    return found.handler as ToolHandler;
}

describe('createModelTools', () => {
    it('sets one helper and keeps the stored choices of the other fields', async () => {
        const store = createFakeStore(STORED);
        const setModels = findHandler(createModelTools(store, 'bot-1'));

        const result = await setModels({ browsing: 'sonnet' }, {});

        expect(result.isError)
            .toBeUndefined();
        expect(store.saved())
            .toEqual({ chat: 'haiku', routines: null, review: null, browsing: 'sonnet', documents: null });
        expect(result.content[0]?.text)
            .toContain('browsing sonnet');
    });

    it('clears a choice when null is passed', async () => {
        const store = createFakeStore(STORED);
        const setModels = findHandler(createModelTools(store, 'bot-1'));

        await setModels({ chat: null }, {});

        expect(store.saved()?.chat)
            .toBeNull();
    });

    it('refuses a model that is not an alias or a full id and saves nothing', async () => {
        const store = createFakeStore(STORED);
        const setModels = findHandler(createModelTools(store, 'bot-1'));

        const result = await setModels({ browsing: 'gpt-4o' }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toContain('The browsing model');
        expect(store.saved())
            .toBeUndefined();
    });
});
