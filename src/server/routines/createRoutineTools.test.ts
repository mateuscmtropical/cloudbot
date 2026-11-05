import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

import type { WorkChange } from '../providers/WorkSettings.ts';
import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { RoutineStore } from '../store/RoutineStore.ts';

import { ROUTINE_SET_WORK_TOOL_FULL_NAME, ROUTINE_TOOL_FULL_NAMES, createRoutineTools, MAX_ROUTINES_PER_BOT } from './createRoutineTools.ts';
import type { RoutineToolResult } from './createRoutineTools.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<RoutineToolResult>;

describe('createRoutineTools', () => {
    let opened: OpenedDatabase;
    let store: RoutineStore;
    let botId: string;
    let otherBotId: string;
    // Stands in for WorkSettings.checkChoice. Tests set its answer when they need a refusal.
    const checkWork = vi.fn<(botId: string, change: WorkChange) => Promise<string | undefined>>();

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new RoutineStore(opened.db, { now: () => Date.UTC(2026, 9, 21, 11, 0) });
        checkWork.mockReset();
        checkWork.mockResolvedValue(undefined);

        const botStore = new BotStore(opened.db);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const otherBot = await botStore.create({ name: 'Bia', title: 'Assistant', description: '' });

        botId = bot.id;
        otherBotId = otherBot.id;
    });

    afterEach(() => {
        opened.close();
    });

    function findHandler(forBotId: string, name: string): ToolHandler {
        const tools = createRoutineTools(store, forBotId, checkWork) as unknown as { name: string; handler: unknown }[];
        const found = tools.find(candidate => candidate.name === name);

        if (found === undefined) {
            throw new Error(`No tool ${name}`);
        }

        return found.handler as ToolHandler;
    }

    it('creates a routine and says when it first runs', async () => {
        const create = findHandler(botId, 'routine_create');
        const result = await create({ name: 'Inbox', prompt: 'Check my inbox.', schedule: { kind: 'daily', hour: 8, minute: 30 } }, {});

        expect(result.isError)
            .toBeUndefined();
        expect(result.content[0]?.text)
            .toContain('2026-10-22T08:30:00.000Z UTC');
        await expect(store.list(botId))
            .resolves.toHaveLength(1);
    });

    it('creates a once routine for a future UTC time and shows that time in the list', async () => {
        const tools = createRoutineTools(store, botId, checkWork, () => Date.UTC(2026, 9, 21, 11, 0)) as unknown as { name: string; handler: ToolHandler }[];
        const create = tools.find(candidate => candidate.name === 'routine_create')?.handler;
        const list = tools.find(candidate => candidate.name === 'routine_list')?.handler;

        const result = await create?.({ name: 'Call mom', prompt: 'Remind me to call mom.', schedule: { kind: 'once', at: '2026-10-21T13:00:00Z' } }, {});
        const listed = await list?.({}, {});
        const [routine] = await store.list(botId);

        expect(result?.isError)
            .toBeUndefined();
        expect(result?.content[0]?.text)
            .toContain('2026-10-21T13:00:00.000Z UTC');
        expect(routine?.schedule)
            .toEqual({ kind: 'once', at: Date.UTC(2026, 9, 21, 13, 0) });
        expect(listed?.content[0]?.text)
            .toContain('{"kind":"once","at":"2026-10-21T13:00:00.000Z"}');
    });

    it('refuses a once time that has passed or is not a time', async () => {
        const tools = createRoutineTools(store, botId, checkWork, () => Date.UTC(2026, 9, 21, 11, 0)) as unknown as { name: string; handler: ToolHandler }[];
        const create = tools.find(candidate => candidate.name === 'routine_create')?.handler;

        const past = await create?.({ name: 'Old', prompt: 'x', schedule: { kind: 'once', at: '2026-10-21T10:59:00Z' } }, {});
        const bad = await create?.({ name: 'Bad', prompt: 'x', schedule: { kind: 'once', at: 'tomorrow' } }, {});
        const missing = await create?.({ name: 'Missing', prompt: 'x', schedule: { kind: 'once' } }, {});

        expect([past?.isError, bad?.isError, missing?.isError])
            .toEqual([true, true, true]);
        expect(past?.content[0]?.text)
            .toContain('has passed');
        await expect(store.list(botId))
            .resolves.toHaveLength(0);
    });

    it('creates a quiet check-in and marks it in the list', async () => {
        const create = findHandler(botId, 'routine_create');
        const list = findHandler(botId, 'routine_list');

        await create({ name: 'Inbox', prompt: 'Check my inbox.', isQuiet: true, schedule: { kind: 'interval', everyMinutes: 180 } }, {});
        await create({ name: 'Brief', prompt: 'Brief me.', schedule: { kind: 'daily', hour: 8, minute: 0 } }, {});

        const routines = await store.list(botId);
        const result = await list({}, {});

        expect(routines.map(routine => routine.isQuiet))
            .toEqual([true, false]);
        expect(result.content[0]?.text)
            .toContain('"Inbox" (quiet check-in)');
        expect(result.content[0]?.text)
            .not.toContain('"Brief" (quiet');
    });

    it('refuses an invalid schedule', async () => {
        const create = findHandler(botId, 'routine_create');
        const result = await create({ name: 'Inbox', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 0 } }, {});

        expect(result.isError)
            .toBe(true);
        await expect(store.list(botId))
            .resolves.toEqual([]);
    });

    it('refuses an unknown schedule key in the arguments, so the bot learns its name', () => {
        const tools = createRoutineTools(store, botId, checkWork) as unknown as { name: string; inputSchema: z.ZodRawShape }[];
        const shape = tools.find(candidate => candidate.name === 'routine_create')?.inputSchema ?? {};
        const schema = z.object(shape);
        const wrong = schema.safeParse({ name: 'Inbox', prompt: 'x', schedule: { kind: 'interval', hours: 3 } });
        const right = schema.safeParse({ name: 'Inbox', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 180 } });

        expect(wrong.error?.issues[0]?.message)
            .toContain('hours');
        expect(right.success)
            .toBe(true);
    });

    it('refuses a routine over the limit', async () => {
        const create = findHandler(botId, 'routine_create');

        await Promise.all(Array.from({ length: MAX_ROUTINES_PER_BOT }, () => store.add(botId, { name: 'A', prompt: 'a', schedule: { kind: 'interval', everyMinutes: 60 } })));

        const result = await create({ name: 'One more', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 } }, {});

        expect(result.isError)
            .toBe(true);
    });

    it('keeps the limit when two routines are created at once', async () => {
        const create = findHandler(botId, 'routine_create');
        const routineArgs = { name: 'A', prompt: 'a', schedule: { kind: 'interval', everyMinutes: 60 } };

        await Promise.all(Array.from({ length: MAX_ROUTINES_PER_BOT - 1 }, () => store.add(botId, { name: 'A', prompt: 'a', schedule: { kind: 'interval', everyMinutes: 60 } })));

        const results = await Promise.all([create(routineArgs, {}), create(routineArgs, {})]);
        const errorCount = results.filter(result => result.isError === true).length;

        expect(errorCount)
            .toBe(1);
        await expect(store.list(botId))
            .resolves.toHaveLength(MAX_ROUTINES_PER_BOT);
    });

    it('lists routines, with off ones marked', async () => {
        const list = findHandler(botId, 'routine_list');
        const empty = await list({}, {});
        const routine = await store.add(botId, { name: 'Inbox', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 } });

        await store.setEnabled(botId, routine.id, false);

        const result = await list({}, {});

        expect(empty.content[0]?.text)
            .toBe('You have no routines.');
        expect(result.content[0]?.text)
            .toContain(`${routine.id}: "Inbox"`);
        expect(result.content[0]?.text)
            .toContain('off');
    });

    it('turns a routine off and deletes it, only for its own bot', async () => {
        const routine = await store.add(botId, { name: 'Inbox', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 } });
        const otherDelete = await findHandler(otherBotId, 'routine_delete')({ id: routine.id }, {});
        const otherToggle = await findHandler(otherBotId, 'routine_set_enabled')({ id: routine.id, isEnabled: false }, {});
        const toggled = await findHandler(botId, 'routine_set_enabled')({ id: routine.id, isEnabled: false }, {});
        const deleted = await findHandler(botId, 'routine_delete')({ id: routine.id }, {});

        expect(otherDelete.isError)
            .toBe(true);
        expect(otherToggle.isError)
            .toBe(true);
        expect(toggled.content[0]?.text)
            .toBe('The routine is off.');
        expect(deleted.isError)
            .toBeUndefined();
        await expect(store.list(botId))
            .resolves.toEqual([]);
    });

    it('creates a routine with its own provider after the choice is checked', async () => {
        const create = findHandler(botId, 'routine_create');
        const result = await create({ name: 'Inbox', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 }, provider: 'gemini', model: 'flash', effort: 'low' }, {});
        const [routine] = await store.list(botId);

        expect(result.isError)
            .toBeUndefined();
        expect(checkWork)
            .toHaveBeenCalledWith(botId, { provider: 'gemini', model: 'flash', effort: 'low' });
        expect(routine)
            .toMatchObject({ provider: 'gemini', model: 'flash', effort: 'low' });
    });

    it('refuses a create whose provider choice is refused, and saves nothing', async () => {
        checkWork.mockResolvedValueOnce('Choose a model from the list of that provider.');
        const create = findHandler(botId, 'routine_create');
        const result = await create({ name: 'Inbox', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 }, provider: 'gemini', model: 'nope' }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toBe('Choose a model from the list of that provider.');
        await expect(store.list(botId))
            .resolves.toEqual([]);
    });

    it('does not check a create that has no provider', async () => {
        const create = findHandler(botId, 'routine_create');

        await create({ name: 'Inbox', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 } }, {});
        const [routine] = await store.list(botId);

        expect(checkWork)
            .not.toHaveBeenCalled();
        expect(routine)
            .toMatchObject({ provider: null, model: null, effort: null });
    });

    it('sets the work of a routine by id, and goes back to the routines choice with a null provider', async () => {
        const routine = await store.add(botId, { name: 'Inbox', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 } });
        const setWork = findHandler(botId, 'routine_set_work');

        const set = await setWork({ id: routine.id, provider: 'chatgpt', model: 'gpt-6', effort: null }, {});
        const [afterSet] = await store.list(botId);
        const cleared = await setWork({ id: routine.id, provider: null }, {});
        const [afterClear] = await store.list(botId);

        expect(set.isError)
            .toBeUndefined();
        expect(set.content[0]?.text)
            .toBe('The routine runs on chatgpt with model gpt-6.');
        expect(afterSet)
            .toMatchObject({ provider: 'chatgpt', model: 'gpt-6', effort: null });
        expect(cleared.content[0]?.text)
            .toBe('The routine follows the routines choice again.');
        expect(afterClear)
            .toMatchObject({ provider: null, model: null, effort: null });
        expect(checkWork)
            .toHaveBeenCalledTimes(1);
    });

    it('refuses routine_set_work when the choice is refused, and changes nothing', async () => {
        const routine = await store.add(botId, { name: 'Inbox', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 } });

        checkWork.mockResolvedValueOnce('Choose a model from the list of that provider.');
        const result = await findHandler(botId, 'routine_set_work')({ id: routine.id, provider: 'gemini', model: 'nope', effort: null }, {});
        const [unchanged] = await store.list(botId);

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toBe('Choose a model from the list of that provider.');
        expect(unchanged?.provider)
            .toBeNull();
    });

    it('answers routine_set_work with an error for a routine of another bot', async () => {
        const routine = await store.add(botId, { name: 'Inbox', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 } });
        const result = await findHandler(otherBotId, 'routine_set_work')({ id: routine.id, provider: null }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toBe('You have no routine with this id.');
    });

    it('lists the provider and model of routines that have one', async () => {
        await store.add(botId, { name: 'Brief', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 }, provider: 'gemini', model: 'flash' });
        await store.add(botId, { name: 'Plain', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 } });
        const result = await findHandler(botId, 'routine_list')({}, {});
        const [brief, plain] = (result.content[0]?.text ?? '').split('\n');

        expect(brief)
            .toContain('runs on gemini with model flash');
        expect(plain)
            .not.toContain('runs on');
    });

    it('registers routine_set_work and refuses an unknown provider in its arguments', () => {
        const tools = createRoutineTools(store, botId, checkWork) as unknown as { name: string; inputSchema: z.ZodRawShape }[];
        const setWork = tools.find(candidate => candidate.name === 'routine_set_work');
        const schema = z.object(setWork?.inputSchema ?? {});

        expect(ROUTINE_TOOL_FULL_NAMES)
            .toContain(ROUTINE_SET_WORK_TOOL_FULL_NAME);
        expect(schema.safeParse({ id: 'x', provider: 'nope', model: null, effort: null }).success)
            .toBe(false);
        expect(schema.safeParse({ id: 'x', provider: null }).success)
            .toBe(true);
    });
});
