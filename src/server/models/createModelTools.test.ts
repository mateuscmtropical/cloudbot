import { describe, expect, it } from 'vitest';

import type { ModelStore } from '../store/ModelStore.ts';
import type { EffortChoices, ModelChoices } from './modelChoices.ts';
import { createModelTools } from './createModelTools.ts';
import type { ModelToolResult } from './createModelTools.ts';
import type { CloudbotTool } from '../agent/createProfileToolServer.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ModelToolResult>;

const STORED: ModelChoices = { chat: 'haiku', routines: null, review: null, browsing: null, documents: null };
const STORED_EFFORTS: EffortChoices = { chat: null, routines: null, review: 'low', browsing: null, documents: null };

interface FakeStore extends Pick<ModelStore, 'get' | 'set' | 'getEfforts' | 'setEfforts'> {
    // The last choices saved, or undefined when nothing was saved.
    saved: () => ModelChoices | undefined;
    savedEfforts: () => EffortChoices | undefined;
}

// Keeps the choices in memory, so the tool is tested without the database.
function createFakeStore(initial: ModelChoices, initialEfforts: EffortChoices = STORED_EFFORTS): FakeStore {
    let current: ModelChoices | undefined;
    let currentEfforts: EffortChoices | undefined;

    return {
        get: () => Promise.resolve(initial),
        set: (_botId: string, choices: ModelChoices) => {
            current = choices;

            return Promise.resolve();
        },
        getEfforts: () => Promise.resolve(initialEfforts),
        setEfforts: (_botId: string, efforts: EffortChoices) => {
            currentEfforts = efforts;

            return Promise.resolve();
        },
        saved: () => current,
        savedEfforts: () => currentEfforts,
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
        expect(store.savedEfforts())
            .toBeUndefined();
    });

    it('sets one effort and keeps the stored efforts of the other fields', async () => {
        const store = createFakeStore(STORED);
        const setModels = findHandler(createModelTools(store, 'bot-1'));

        const result = await setModels({ chatEffort: 'max' }, {});

        expect(result.isError)
            .toBeUndefined();
        expect(store.savedEfforts())
            .toEqual({ chat: 'max', routines: null, review: 'low', browsing: null, documents: null });
        expect(store.saved())
            .toEqual(STORED);
        expect(result.content[0]?.text)
            .toContain('chat haiku (max)');
    });

    it('clears an effort when null is passed, and says the default', async () => {
        const store = createFakeStore(STORED);
        const setModels = findHandler(createModelTools(store, 'bot-1'));

        const result = await setModels({ reviewEffort: null }, {});

        expect(store.savedEfforts()?.review)
            .toBeNull();
        expect(result.content[0]?.text)
            .toContain('review default model (default effort)');
    });

    it('sets a model and its effort in one call', async () => {
        const store = createFakeStore(STORED);
        const setModels = findHandler(createModelTools(store, 'bot-1'));

        await setModels({ documents: 'sonnet', documentsEffort: 'high' }, {});

        expect(store.saved()?.documents)
            .toBe('sonnet');
        expect(store.savedEfforts()?.documents)
            .toBe('high');
    });

    it('refuses an effort level that is not on the list and saves nothing', async () => {
        const store = createFakeStore(STORED);
        const setModels = findHandler(createModelTools(store, 'bot-1'));

        const result = await setModels({ browsing: 'haiku', browsingEffort: 'extreme' }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toContain('The browsing effort');
        expect(store.saved())
            .toBeUndefined();
        expect(store.savedEfforts())
            .toBeUndefined();
    });
});
