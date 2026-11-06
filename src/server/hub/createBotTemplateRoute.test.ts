import { describe, expect, it, vi } from 'vitest';

import { ACTING_PERSON_HEADER, HUB_BOT_TEMPLATE_PATH, HUB_TRUST_HEADER } from '../../shared/hubProtocol.ts';
import { createBotTemplateRoute } from './createBotTemplateRoute.ts';

function post(headers: Record<string, string>): RequestInit {
    return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ template: '{"cloudbotTemplate":1}' }) };
}

describe('createBotTemplateRoute', () => {
    it('makes the bot only for the hub itself, never for a person through the hub', async () => {
        const importTemplate = vi.fn(() => Promise.resolve({ name: 'Ana' }));
        const routes = createBotTemplateRoute({ hubSecret: 'group-secret', importTemplate });
        const fromHub = await routes.request(HUB_BOT_TEMPLATE_PATH, post({ [HUB_TRUST_HEADER]: 'group-secret' }));
        const throughHub = await routes.request(HUB_BOT_TEMPLATE_PATH, post({ [HUB_TRUST_HEADER]: 'group-secret', [ACTING_PERSON_HEADER]: 'maria' }));
        const withoutSecret = await routes.request(HUB_BOT_TEMPLATE_PATH, post({}));

        expect(fromHub.status)
            .toBe(201);
        expect(await fromHub.json())
            .toEqual({ name: 'Ana' });
        expect(throughHub.status)
            .toBe(403);
        expect(withoutSecret.status)
            .toBe(403);
        expect(importTemplate)
            .toHaveBeenCalledTimes(1);
    });

    it('answers 409 with the reason when the template is refused', async () => {
        const routes = createBotTemplateRoute({ hubSecret: 'group-secret', importTemplate: () => Promise.reject(new Error('The name is too long.')) });
        const answer = await routes.request(HUB_BOT_TEMPLATE_PATH, post({ [HUB_TRUST_HEADER]: 'group-secret' }));

        expect(answer.status)
            .toBe(409);
        expect(await answer.json())
            .toEqual({ error: 'The name is too long.' });
    });
});
