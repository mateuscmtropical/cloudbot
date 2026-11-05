import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { WorkKindSummary } from '../../shared/providerTypes.ts';
import { createWorkSettingsRoutes } from './createWorkSettingsRoutes.ts';
import { WORK_KINDS } from './WorkSettings.ts';
import type { WorkChange, WorkKind } from './WorkSettings.ts';

type SaveFunction = (botId: string, kind: WorkKind, change: WorkChange) => Promise<string | undefined>;
type DescribeFunction = (botId: string) => Promise<WorkKindSummary[]>;
type RoutesApp = ReturnType<typeof createWorkSettingsRoutes>;

const CHANGE = { provider: 'gemini', model: null, effort: null };

function makeApp(problem?: string): { app: RoutesApp; save: Mock<SaveFunction>; describeWork: Mock<DescribeFunction> } {
    const save = vi.fn<SaveFunction>(() => Promise.resolve(problem));
    const describeWork = vi.fn<DescribeFunction>(() => Promise.resolve([]));
    const app = createWorkSettingsRoutes({
        workSettings: { describe: describeWork, save },
        hasBot: botId => Promise.resolve(botId === 'bot-1'),
    });

    return { app, save, describeWork };
}

async function putChange(app: RoutesApp, kind: string, body: unknown): Promise<Response> {
    return app.request(`/api/bots/bot-1/work/${kind}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('work settings routes', () => {
    it('lists the choices of the bot', async () => {
        const { app, describeWork } = makeApp();
        const response = await app.request('/api/bots/bot-1/work');

        expect(response.status)
            .toBe(200);
        expect(describeWork)
            .toHaveBeenCalledWith('bot-1');
    });

    it('answers 404 for a bot it does not know', async () => {
        const { app } = makeApp();
        const response = await app.request('/api/bots/bot-2/work');

        expect(response.status)
            .toBe(404);
    });

    it('saves a choice for every kind of work, the new ones included', async () => {
        const { app, save } = makeApp();
        const responses = await Promise.all(WORK_KINDS.map(kind => putChange(app, kind, CHANGE)));

        expect(responses.map(response => response.status))
            .toEqual(WORK_KINDS.map(() => 200));

        const savedKinds = save.mock.calls.map(call => call[1]);

        expect([...savedKinds].sort())
            .toEqual([...WORK_KINDS].sort());
        expect(save)
            .toHaveBeenCalledWith('bot-1', 'checkins', CHANGE);
    });

    it('answers 404 for a kind of work it does not know', async () => {
        const { app, save } = makeApp();
        const response = await putChange(app, 'chat', CHANGE);

        expect(response.status)
            .toBe(404);
        expect(save)
            .not.toHaveBeenCalled();
    });

    it('answers 400 with the problem when the save refuses the change', async () => {
        const { app } = makeApp('Connect that provider first.');
        const response = await putChange(app, 'search', CHANGE);

        expect(response.status)
            .toBe(400);
        expect(await response.json())
            .toEqual({ error: 'Connect that provider first.' });
    });

    it('answers 400 when the body names no known provider', async () => {
        const { app, save } = makeApp();
        const response = await putChange(app, 'webhooks', { provider: 'nobody', model: null, effort: null });

        expect(response.status)
            .toBe(400);
        expect(save)
            .not.toHaveBeenCalled();
    });
});
