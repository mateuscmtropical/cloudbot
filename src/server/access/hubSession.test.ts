import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { ACTING_PERSON_HEADER, ACTING_ROLE_HEADER, HUB_TRUST_HEADER } from '../../shared/hubProtocol.ts';
import { isValidHubSecret, readActingPerson } from './hubSession.ts';

describe('isValidHubSecret', () => {
    it('accepts the configured secret and refuses a wrong secret', () => {
        expect(isValidHubSecret('instance-secret', 'instance-secret'))
            .toBe(true);
        expect(isValidHubSecret('wrong-secret!', 'instance-secret'))
            .toBe(false);
    });

    it('refuses a missing or wrong length secret without throwing', () => {
        expect(isValidHubSecret(undefined, 'instance-secret'))
            .toBe(false);
        expect(isValidHubSecret('short', 'instance-secret'))
            .toBe(false);
    });
});

describe('readActingPerson', () => {
    it('trusts the person and role only next to the hub secret', async () => {
        const app = new Hono();

        app.get('/who', context => context.json(readActingPerson(context, 'hub-secret') ?? null));

        const fromHub = await app.request('/who', { headers: { [HUB_TRUST_HEADER]: 'hub-secret', [ACTING_PERSON_HEADER]: 'maria', [ACTING_ROLE_HEADER]: 'admin' } });
        const forged = await app.request('/who', { headers: { [HUB_TRUST_HEADER]: 'wrong-secret', [ACTING_PERSON_HEADER]: 'maria', [ACTING_ROLE_HEADER]: 'owner' } });
        const unknownRole = await app.request('/who', { headers: { [HUB_TRUST_HEADER]: 'hub-secret', [ACTING_PERSON_HEADER]: 'maria', [ACTING_ROLE_HEADER]: 'boss' } });

        expect(await fromHub.json())
            .toEqual({ name: 'maria', role: 'admin' });
        expect(await forged.json())
            .toBeNull();
        expect(await unknownRole.json())
            .toBeNull();
    });
});
