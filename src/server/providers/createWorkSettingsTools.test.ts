import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { z } from 'zod/v4';

import type { WorkKindSummary } from '../../shared/providerTypes.ts';
import { createWorkSettingsTools } from './createWorkSettingsTools.ts';
import type { WorkToolDependencies } from './createWorkSettingsTools.ts';
import { WORK_KINDS } from './WorkSettings.ts';
import type { WorkChange, WorkKind } from './WorkSettings.ts';
import type { ProviderId } from './providerIds.ts';

interface CallableTool {
    name: string;
    inputSchema: z.ZodRawShape;
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

type SaveFunction = (botId: string, kind: WorkKind, change: WorkChange) => Promise<string | undefined>;

function summaryOf(kind: string): WorkKindSummary {
    return {
        kind,
        label: kind,
        provider: null,
        usedProvider: 'claude',
        usedProviderLabel: 'Claude',
        usedModel: 'Opus',
        usedEffort: null,
        selectedModel: null,
        selectedEffort: null,
        modelOptions: [],
        effortOptions: [],
        allowedProviders: null,
        choosableProviders: [],
        providerModels: {},
    };
}

function makeTools(connected: ProviderId[], problem?: string, summaries: WorkKindSummary[] = []): { tools: CallableTool[]; save: Mock<SaveFunction> } {
    const save = vi.fn<SaveFunction>(() => Promise.resolve(problem));
    const dependencies: WorkToolDependencies = {
        workSettings: { describe: () => Promise.resolve(summaries), save },
        connected: () => Promise.resolve(connected),
        describeChat: () => Promise.resolve('Claude, model opus'),
    };
    const tools = createWorkSettingsTools(dependencies, 'bot-1') as unknown as CallableTool[];

    return { tools, save };
}

function findTool(tools: CallableTool[], name: string): CallableTool {
    const found = tools.find(entry => entry.name === name);

    if (found === undefined) {
        throw new Error(`No tool named ${name}.`);
    }

    return found;
}

describe('work settings tools', () => {
    it('lists the provider and model of every kind of work, the new ones included', async () => {
        const summaries = WORK_KINDS.map(kind => summaryOf(kind));
        const { tools } = makeTools(['claude'], undefined, summaries);
        const listTool = findTool(tools, 'work_settings_list');
        const result = await listTool.handler({}, {});
        const text = result.content[0]?.text ?? '';

        expect(text)
            .toContain('chat: Claude, model opus');
        expect(text)
            .toContain('search: Claude, model Opus, effort provider default');
        expect(text)
            .toContain('checkins: Claude, model Opus, effort provider default');
        expect(text)
            .toContain('webhooks: Claude, model Opus, effort provider default');
    });

    it('accepts every kind of work in work_settings_set, and no other', () => {
        const { tools } = makeTools(['claude']);
        const setTool = findTool(tools, 'work_settings_set');
        const schema = z.object(setTool.inputSchema);

        WORK_KINDS.forEach((kind) => {
            expect(schema.safeParse({ kind, provider: null }).success)
                .toBe(true);
        });
        expect(schema.safeParse({ kind: 'chat', provider: null }).success)
            .toBe(false);
    });

    it('saves a choice for a new kind of work once its provider is connected', async () => {
        const { tools, save } = makeTools(['claude']);
        const setTool = findTool(tools, 'work_settings_set');
        const result = await setTool.handler({ kind: 'checkins', provider: 'claude', model: 'haiku', effort: 'low' }, {});

        expect(save)
            .toHaveBeenCalledWith('bot-1', 'checkins', { provider: 'claude', model: 'haiku', effort: 'low' });
        expect(result.isError)
            .toBeUndefined();
        expect(result.content[0]?.text)
            .toMatch(/^Saved\. Now:/);
    });

    it('follows the chat with a null provider and fills the missing model and effort with null', async () => {
        const { tools, save } = makeTools(['claude']);
        const setTool = findTool(tools, 'work_settings_set');

        await setTool.handler({ kind: 'webhooks', provider: null }, {});

        expect(save)
            .toHaveBeenCalledWith('bot-1', 'webhooks', { provider: null, model: null, effort: null });
    });

    it('refuses a provider that is not connected before saving anything', async () => {
        const { tools, save } = makeTools(['claude']);
        const setTool = findTool(tools, 'work_settings_set');
        const result = await setTool.handler({ kind: 'search', provider: 'gemini' }, {});

        expect(result)
            .toMatchObject({
                isError: true,
                content: [{ text: 'Gemini is not connected. Call provider_connect so the owner can sign in first.' }],
            });
        expect(save)
            .not.toHaveBeenCalled();
    });

    it('returns the problem of a refused save as an error', async () => {
        const { tools } = makeTools(['gemini'], 'Choose a model from the list of that provider.');
        const setTool = findTool(tools, 'work_settings_set');
        const result = await setTool.handler({ kind: 'search', provider: 'gemini', model: 'nope' }, {});

        expect(result)
            .toMatchObject({ isError: true, content: [{ text: 'Choose a model from the list of that provider.' }] });
    });
});
