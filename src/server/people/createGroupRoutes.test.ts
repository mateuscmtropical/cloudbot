import { describe, expect, it, vi } from 'vitest';

import type { SharedGroup } from '../../shared/peopleTypes.ts';
import { createGroupRoutes } from './createGroupRoutes.ts';
import type { GroupsAdmin } from './createGroupRoutes.ts';

const TEAM: SharedGroup = { name: 'team', address: 'https://team.example.test', instance: 'running', members: [], createdAt: 0 };

function createAdmin(): GroupsAdmin {
    return {
        listGroups: () => Promise.resolve([TEAM]),
        addGroup: () => Promise.resolve(TEAM),
        setGroupMember: () => Promise.resolve(TEAM),
        removeGroup: () => Promise.resolve(),
        sendBotToGroup: () => Promise.resolve('Ana'),
    };
}

function send(mode: string): RequestInit {
    return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botId: 'bot-1', mode }) };
}

describe('createGroupRoutes', () => {
    it('copies a bot and leaves it here', async () => {
        const removeBot = vi.fn(() => Promise.resolve('deleted'));
        const routes = createGroupRoutes({ groupsAdmin: createAdmin(), exportBot: () => Promise.resolve('{}'), removeBot });
        const answer = await routes.request('/api/groups/team/bots', send('copy'));

        expect(await answer.json())
            .toEqual({ name: 'Ana', isMoved: false });
        expect(removeBot).not.toHaveBeenCalled();
    });

    it('moves a bot, and says so when it had to stay here too', async () => {
        const moved = createGroupRoutes({ groupsAdmin: createAdmin(), exportBot: () => Promise.resolve('{}'), removeBot: () => Promise.resolve('deleted') });
        const stayed = createGroupRoutes({ groupsAdmin: createAdmin(), exportBot: () => Promise.resolve('{}'), removeBot: () => Promise.resolve('The last bot cannot be deleted.') });
        const movedAnswer = await moved.request('/api/groups/team/bots', send('move'));
        const stayedAnswer = await stayed.request('/api/groups/team/bots', send('move'));

        expect(await movedAnswer.json())
            .toEqual({ name: 'Ana', isMoved: true });
        expect(await stayedAnswer.json())
            .toEqual({ name: 'Ana', isMoved: false, problem: 'The group has a copy, but it stayed here too. The last bot cannot be deleted.' });
    });

    it('deletes a group only when its name is typed again', async () => {
        const admin = createAdmin();
        const removeGroup = vi.spyOn(admin, 'removeGroup');
        const routes = createGroupRoutes({ groupsAdmin: admin, exportBot: () => Promise.resolve('{}'), removeBot: () => Promise.resolve('deleted') });
        const unconfirmed = await routes.request('/api/groups/team?confirm=other', { method: 'DELETE' });
        const confirmed = await routes.request('/api/groups/team?confirm=team', { method: 'DELETE' });

        expect(unconfirmed.status)
            .toBe(400);
        expect(confirmed.status)
            .toBe(204);
        expect(removeGroup)
            .toHaveBeenCalledTimes(1);
    });

    it('refuses an unknown mode', async () => {
        const routes = createGroupRoutes({ groupsAdmin: createAdmin(), exportBot: () => Promise.resolve('{}'), removeBot: () => Promise.resolve('deleted') });
        const answer = await routes.request('/api/groups/team/bots', send('steal'));

        expect(answer.status)
            .toBe(400);
    });
});
