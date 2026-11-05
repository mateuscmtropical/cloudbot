import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotRoutine } from '../../shared/routineTypes.ts';
import type { WorkChange } from '../providers/WorkSettings.ts';
import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { RoutineStore } from '../store/RoutineStore.ts';

import { createRoutineRoutes } from './createRoutineRoutes.ts';

const WORK_BODY = { provider: 'gemini', model: 'flash', effort: 'low' };

describe('createRoutineRoutes', () => {
    let opened: OpenedDatabase;
    let store: RoutineStore;
    let botId: string;
    let otherBotId: string;
    let routineId: string;
    // Stands in for WorkSettings.checkChoice. Tests set its answer when they need a refusal.
    const checkWorkChoice = vi.fn<(botId: string, change: WorkChange) => Promise<string | undefined>>();

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new RoutineStore(opened.db);
        checkWorkChoice.mockReset();
        checkWorkChoice.mockResolvedValue(undefined);

        const botStore = new BotStore(opened.db);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const otherBot = await botStore.create({ name: 'Bia', title: 'Assistant', description: '' });

        botId = bot.id;
        otherBotId = otherBot.id;

        const routine = await store.add(botId, { name: 'Inbox', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 } });

        routineId = routine.id;
    });

    afterEach(() => {
        opened.close();
    });

    function createApp(): ReturnType<typeof createRoutineRoutes> {
        return createRoutineRoutes({
            routineStore: store,
            hasBot: knownBotId => Promise.resolve(knownBotId === botId || knownBotId === otherBotId),
            checkWorkChoice,
        });
    }

    function putWork(app: ReturnType<typeof createRoutineRoutes>, path: string, body: string): Response | Promise<Response> {
        return app.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
    }

    it('lists the provider, model and effort of each routine', async () => {
        await store.setWork(botId, routineId, WORK_BODY);

        const app = createApp();
        const response = await app.request(`/api/bots/${botId}/routines`);
        const routines = await response.json() as BotRoutine[];

        expect(response.status)
            .toBe(200);
        expect(routines[0])
            .toMatchObject(WORK_BODY);
    });

    it('sets the work of a routine and answers with the updated routine', async () => {
        const response = await putWork(createApp(), `/api/bots/${botId}/routines/${routineId}/work`, JSON.stringify(WORK_BODY));
        const routine = await response.json() as BotRoutine;

        expect(response.status)
            .toBe(200);
        expect(routine)
            .toMatchObject({ id: routineId, name: 'Inbox', ...WORK_BODY });
        expect(checkWorkChoice)
            .toHaveBeenCalledWith(botId, WORK_BODY);
        await expect(store.list(botId))
            .resolves.toMatchObject([WORK_BODY]);
    });

    it('goes back to the routines choice with a null provider, without a check', async () => {
        await store.setWork(botId, routineId, WORK_BODY);

        const response = await putWork(createApp(), `/api/bots/${botId}/routines/${routineId}/work`, JSON.stringify({ provider: null, model: null, effort: null }));
        const routine = await response.json() as BotRoutine;

        expect(response.status)
            .toBe(200);
        expect(routine)
            .toMatchObject({ provider: null, model: null, effort: null });
        expect(checkWorkChoice)
            .not.toHaveBeenCalled();
    });

    it('answers 400 for a provider this app does not know', async () => {
        const response = await putWork(createApp(), `/api/bots/${botId}/routines/${routineId}/work`, JSON.stringify({ ...WORK_BODY, provider: 'nope' }));

        expect(response.status)
            .toBe(400);
        expect(checkWorkChoice)
            .not.toHaveBeenCalled();
        await expect(store.list(botId))
            .resolves.toMatchObject([{ provider: null }]);
    });

    it('answers 400 with the problem when the choice is refused, and saves nothing', async () => {
        checkWorkChoice.mockResolvedValueOnce('Choose a model from the list of that provider.');

        const response = await putWork(createApp(), `/api/bots/${botId}/routines/${routineId}/work`, JSON.stringify(WORK_BODY));

        expect(response.status)
            .toBe(400);
        await expect(response.json())
            .resolves.toEqual({ error: 'Choose a model from the list of that provider.' });
        await expect(store.list(botId))
            .resolves.toMatchObject([{ provider: null }]);
    });

    it('answers 400 when a field is missing or the body is not JSON', async () => {
        const missingEffort = await putWork(createApp(), `/api/bots/${botId}/routines/${routineId}/work`, JSON.stringify({ provider: null, model: null }));
        const notJson = await putWork(createApp(), `/api/bots/${botId}/routines/${routineId}/work`, 'not json');

        expect([missingEffort.status, notJson.status])
            .toEqual([400, 400]);
    });

    it('answers 404 for a routine of another bot, and for an unknown bot', async () => {
        const otherRoutine = await store.add(otherBotId, { name: 'Other', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 60 } });
        const notOwn = await putWork(createApp(), `/api/bots/${botId}/routines/${otherRoutine.id}/work`, JSON.stringify(WORK_BODY));
        const unknownBot = await putWork(createApp(), '/api/bots/nobody/routines/any/work', JSON.stringify(WORK_BODY));

        expect(notOwn.status)
            .toBe(404);
        expect(unknownBot.status)
            .toBe(404);
        await expect(store.list(otherBotId))
            .resolves.toMatchObject([{ provider: null }]);
    });
});
