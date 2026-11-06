import { describe, expect, it, vi } from 'vitest';

import { INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../../shared/hubProtocol.ts';
import type { MyGroup } from '../../shared/peopleTypes.ts';
import { createMyGroupsRoute, fetchMyGroups } from './createMyGroupsRoute.ts';

const CONFIG = { hubUrl: 'http://hub:3001', secret: 'maria-secret', personName: 'maria', role: 'member' as const };
const TEAM: MyGroup = { name: 'team', openPath: '/__hub/groups/team/open', role: 'admin' };

describe('fetchMyGroups', () => {
    it('asks the hub as this person and gives its groups', async () => {
        const fakeFetch = vi.fn(() => Promise.resolve(Response.json([TEAM])));
        const groups = await fetchMyGroups(CONFIG, fakeFetch);

        expect(groups)
            .toEqual([TEAM]);
        expect(fakeFetch)
            .toHaveBeenCalledWith('http://hub:3001/internal/my-groups', { headers: { [INSTANCE_NAME_HEADER]: 'maria', [INSTANCE_SECRET_HEADER]: 'maria-secret' } });
    });

    it('gives no groups when the hub refuses or cannot be reached', async () => {
        const refused = await fetchMyGroups(CONFIG, () => Promise.resolve(Response.json({ error: 'Not found.' }, { status: 404 })));
        const unreachable = await fetchMyGroups(CONFIG, () => Promise.reject(new Error('down')));

        expect(refused)
            .toEqual([]);
        expect(unreachable)
            .toEqual([]);
    });
});

describe('createMyGroupsRoute', () => {
    it('answers the groups of this person', async () => {
        const routes = createMyGroupsRoute(() => Promise.resolve([TEAM]));
        const answer = await routes.request('/api/my-groups');

        expect(await answer.json())
            .toEqual([TEAM]);
    });
});
