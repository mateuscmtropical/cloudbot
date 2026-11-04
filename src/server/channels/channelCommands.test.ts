import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from '../store/BotStore.ts';
import { ChannelStore } from '../store/ChannelStore.ts';
import type { Channel } from '../store/ChannelStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import type { Bot } from '../store/types.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { addMember, createChannel, createOwnerChannel, deleteChannel, findNameClash, listChannels, reachableBots, removeMember, setManager, updateOwnerChannel } from './channelCommands.ts';
import type { ChannelCommandDeps } from './channelCommands.ts';

describe('reachableBots', () => {
    const makeBot = (id: string): Bot => ({ id, name: id }) as Bot;
    const makeChannel = (isIsolated: boolean, ...botIds: string[]): Channel => ({
        id: botIds.join('-'),
        name: botIds.join('-'),
        isIsolated,
        createdAt: 0,
        members: botIds.map(botId => ({ botId, isManager: false, joinedAt: 0 })),
    });
    const bots = ['ana', 'ben', 'carl', 'dee'].map(makeBot);
    const reachFrom = (channels: Channel[], botId: string): string[] => reachableBots(bots, channels, botId)
        .map(bot => bot.id);

    it('reaches every other bot when nothing is isolated, even across a plain group', () => {
        const channels = [makeChannel(false, 'ana', 'ben')];

        expect(reachFrom(channels, 'ana'))
            .toEqual(['ben', 'carl', 'dee']);
        expect(reachFrom(channels, 'carl'))
            .toEqual(['ana', 'ben', 'dee']);
    });

    it('keeps an isolated member inside its group, and outsiders out, in both directions', () => {
        const channels = [makeChannel(true, 'ana', 'ben')];

        expect(reachFrom(channels, 'ana'))
            .toEqual(['ben']);
        expect(reachFrom(channels, 'carl'))
            .toEqual(['dee']);
    });

    it('lets a bot in two isolated groups reach both, and the two groups stay apart', () => {
        const channels = [makeChannel(true, 'ana', 'ben'), makeChannel(true, 'ben', 'carl')];

        expect(reachFrom(channels, 'ben'))
            .toEqual(['ana', 'carl']);
        expect(reachFrom(channels, 'ana'))
            .toEqual(['ben']);
        expect(reachFrom(channels, 'dee'))
            .toEqual([]);
    });

    it('keeps an isolated member from outsiders it shares a plain group with', () => {
        const channels = [makeChannel(true, 'ana', 'ben'), makeChannel(false, 'ana', 'carl')];

        expect(reachFrom(channels, 'ana'))
            .toEqual(['ben']);
        expect(reachFrom(channels, 'carl'))
            .toEqual(['dee']);
    });
});

describe('channel commands', () => {
    let opened: OpenedDatabase;
    let deps: ChannelCommandDeps;
    let anaId: string;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        deps = { bots: new BotStore(opened.db), channels: new ChannelStore(opened.db) };
        const ana = await deps.bots.create({ name: 'Ana', title: 'Manager', description: '' });

        anaId = ana.id;
        await deps.bots.create({ name: 'Ben', title: 'Helper', description: '' });
    });

    afterEach(() => {
        opened.close();
    });

    it('creates a channel with the calling bot as manager and the named bots as members', async () => {
        const result = await createChannel(deps, anaId, { name: 'Project', memberNames: ['Ben'] });
        const channel = await deps.channels.findByName('Project');
        const managerIds = channel?.members.filter(member => member.isManager)
            .map(member => member.botId);

        expect(result.isError)
            .toBe(false);
        expect(managerIds)
            .toEqual([anaId]);
        expect(channel?.members)
            .toHaveLength(2);
    });

    it('lets the owner make a channel, then change its name, members, manager and isolation', async () => {
        const ben = await deps.bots.create({ name: 'Bea', title: 'Helper', description: '' });
        const left: string[] = [];
        const withHook: ChannelCommandDeps = {
            ...deps,
            memberLeft: (channelId, botId) => {
                left.push(botId);

                return Promise.resolve();
            },
        };
        const created = await createOwnerChannel(withHook, { name: 'Project', memberIds: [anaId], managerId: anaId, isIsolated: true });

        if ('error' in created) {
            throw new Error(created.error);
        }

        expect(created.value.isIsolated)
            .toBe(true);

        const problem = await updateOwnerChannel(withHook, created.value, { name: 'Launch', memberIds: [ben.id], managerId: ben.id, isIsolated: false });
        const updated = await deps.channels.getById(created.value.id);

        expect(problem)
            .toBeUndefined();
        expect(updated?.name)
            .toBe('Launch');
        expect(updated?.isIsolated)
            .toBe(false);
        expect(updated?.members.map(member => [member.botId, member.isManager]))
            .toEqual([[ben.id, true]]);
        expect(left)
            .toEqual([anaId]);
    });

    it('refuses owner settings with a missing bot, a shared name or an outside manager, and changes nothing', async () => {
        const twin = await deps.bots.create({ name: 'ana', title: 'Twin', description: '' });
        const missing = await createOwnerChannel(deps, { name: 'One', memberIds: ['gone'], managerId: 'gone', isIsolated: false });
        const sameName = await createOwnerChannel(deps, { name: 'Two', memberIds: [anaId, twin.id], managerId: anaId, isIsolated: false });
        const outsideManager = await createOwnerChannel(deps, { name: 'Three', memberIds: [anaId], managerId: twin.id, isIsolated: false });

        expect(missing)
            .toEqual({ error: 'One of the bots no longer exists.' });
        expect(sameName)
            .toEqual({ error: 'Two members of a channel cannot share a name. Rename one of them first.' });
        expect(outsideManager)
            .toEqual({ error: 'The manager must be one of the channel members.' });
        expect(await deps.channels.list())
            .toEqual([]);
    });

    it('refuses a name that matches no bot, and does not make the channel', async () => {
        const result = await createChannel(deps, anaId, { name: 'Project', memberNames: ['Nobody'] });
        const channels = await deps.channels.list();

        expect(result)
            .toEqual({ text: 'No bot is named Nobody.', isError: true });
        expect(channels)
            .toEqual([]);
    });

    it('refuses a name that two bots share', async () => {
        await deps.bots.create({ name: 'Ben', title: 'Other', description: '' });

        const result = await createChannel(deps, anaId, { name: 'Project', memberNames: ['Ben'] });

        expect(result.isError)
            .toBe(true);
        expect(result.text)
            .toContain('More than one bot');
    });

    it('lists the channels with the manager marked', async () => {
        await createChannel(deps, anaId, { name: 'Project', memberNames: ['Ben'] });

        const result = await listChannels(deps, anaId);

        expect(result.text)
            .toContain('Project: Ana (manager), Ben');
    });

    it('adds a bot once and refuses a second add', async () => {
        const created = await createChannel(deps, anaId, { name: 'Project', memberNames: [] });
        const carl = await deps.bots.create({ name: 'Carl', title: 'Helper', description: '' });
        const firstAdd = await addMember(deps, { channel: 'project', bot: 'Carl' }, anaId);
        const secondAdd = await addMember(deps, { channel: 'Project', bot: 'Carl' }, anaId);
        const channel = await deps.channels.findByName('Project');
        const memberIds = channel?.members.map(member => member.botId);

        expect(firstAdd.isError)
            .toBe(false);
        expect(created.isError)
            .toBe(false);
        expect(secondAdd.text)
            .toContain('already in the channel');
        expect(memberIds)
            .toContain(carl.id);
    });

    it('moves the manager role and then refuses to remove the old manager', async () => {
        await createChannel(deps, anaId, { name: 'Project', memberNames: ['Ben'] });

        const moved = await setManager(deps, { channel: 'Project', bot: 'Ben' }, anaId);
        const anaLeaves = await removeMember(deps, { channel: 'Project', bot: 'Ana' });
        const benLeaves = await removeMember(deps, { channel: 'Project', bot: 'Ben' });

        expect(moved.text)
            .toBe('Ben is now the manager of Project.');
        expect(anaLeaves.isError)
            .toBe(false);
        expect(benLeaves.text)
            .toContain('cannot leave');
    });

    it('deletes a channel by name', async () => {
        await createChannel(deps, anaId, { name: 'Project', memberNames: [] });

        const missing = await deleteChannel(deps, { channel: 'Nope' });
        const deleted = await deleteChannel(deps, { channel: 'Project' });
        const channels = await deps.channels.list();

        expect(missing.isError)
            .toBe(true);
        expect(deleted.text)
            .toBe('Deleted the channel Project.');
        expect(channels)
            .toEqual([]);
    });

    it('lists only the channels the calling bot is in', async () => {
        const carl = await deps.bots.create({ name: 'Carl', title: 'Helper', description: '' });

        await createChannel(deps, anaId, { name: 'Project', memberNames: ['Ben'] });
        await createChannel(deps, carl.id, { name: 'Other', memberNames: [] });

        const anaView = await listChannels(deps, anaId);
        const carlView = await listChannels(deps, carl.id);

        expect(anaView.text)
            .toContain('Project');
        expect(anaView.text)
            .not.toContain('Other');
        expect(carlView.text)
            .toContain('Other');
        expect(carlView.text)
            .not.toContain('Project');
    });

    it('lets only the manager add a member or change the manager', async () => {
        const ben = await deps.bots.list();
        const benId = ben.find(bot => bot.name === 'Ben')?.id ?? '';

        await createChannel(deps, anaId, { name: 'Project', memberNames: ['Ben'] });
        await deps.bots.create({ name: 'Carl', title: 'Helper', description: '' });

        const addByMember = await addMember(deps, { channel: 'Project', bot: 'Carl' }, benId);
        const setByMember = await setManager(deps, { channel: 'Project', bot: 'Carl' }, benId);
        const channel = await deps.channels.findByName('Project');

        expect(addByMember.isError)
            .toBe(true);
        expect(addByMember.text)
            .toBe('Only the manager of Project can add members.');
        expect(setByMember.isError)
            .toBe(true);
        expect(channel?.members.find(member => member.isManager)?.botId)
            .toBe(anaId);
    });

    it('finds a name clash only for a bot in a channel that has another member with that name', async () => {
        await createChannel(deps, anaId, { name: 'Project', memberNames: ['Ben'] });
        const carl = await deps.bots.create({ name: 'Carl', title: 'Helper', description: '' });
        const bots = await deps.bots.list();
        const channels = await deps.channels.list();

        const benId = bots.find(bot => bot.name === 'Ben')?.id ?? '';

        const clash = findNameClash(channels, bots, benId, ' Ana ');
        const ownName = findNameClash(channels, bots, anaId, 'Ana');
        const notInChannel = findNameClash(channels, bots, carl.id, 'Ana');

        expect(clash)
            .toBe('Ana is already the name of a member of Project. Pick another name.');
        expect(ownName)
            .toBeUndefined();
        expect(notInChannel)
            .toBeUndefined();
    });

    it('tells the member-left hook about a removed member, and the channel-deleting hook before a delete', async () => {
        const calls: string[] = [];
        const hookedDeps: ChannelCommandDeps = {
            ...deps,
            memberLeft: (channelId: string, botId: string) => {
                calls.push(`left:${channelId}:${botId}`);

                return Promise.resolve();
            },
            channelDeleting: (channelId: string) => {
                calls.push(`deleting:${channelId}`);

                return Promise.resolve();
            },
        };
        const created = await createChannel(hookedDeps, anaId, { name: 'Project', memberNames: ['Ben'] });
        const channel = await deps.channels.findByName('Project');
        const benId = channel?.members.find(member => !member.isManager)?.botId ?? '';

        await removeMember(hookedDeps, { channel: 'Project', bot: 'Ben' });
        await deleteChannel(hookedDeps, { channel: 'Project' });

        expect(created.isError)
            .toBe(false);
        expect(calls)
            .toEqual([`left:${channel?.id ?? ''}:${benId}`, `deleting:${channel?.id ?? ''}`]);
    });
});
