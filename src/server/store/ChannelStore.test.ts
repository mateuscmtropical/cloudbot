import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import { ChannelError, ChannelStore } from './ChannelStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';

describe('ChannelStore', () => {
    let opened: OpenedDatabase;
    let bots: BotStore;
    let channels: ChannelStore;
    let managerId: string;
    let memberId: string;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        bots = new BotStore(opened.db);
        channels = new ChannelStore(opened.db);
        const manager = await bots.create({ name: 'Ana', title: 'Manager', description: '' });
        const member = await bots.create({ name: 'Ben', title: 'Helper', description: '' });

        managerId = manager.id;
        memberId = member.id;
    });

    afterEach(() => {
        opened.close();
    });

    it('creates a channel with one manager among its members', async () => {
        const channel = await channels.create({ name: 'Project', managerId, memberIds: [managerId, memberId] });
        const pairs = channel.members.map(member => [member.botId, member.isManager]);

        // Members joined in the same millisecond, so the order is not fixed. Only the pairs matter here.
        expect(pairs)
            .toEqual(expect.arrayContaining([[managerId, true], [memberId, false]]));
        expect(channel.members)
            .toHaveLength(2);
    });

    it('refuses a manager who is not a member', async () => {
        const attempt = channels.create({ name: 'Project', managerId, memberIds: [memberId] });

        await expect(attempt)
            .rejects.toBeInstanceOf(ChannelError);
    });

    it('refuses a second channel with the same name, without case', async () => {
        await channels.create({ name: 'Project', managerId, memberIds: [managerId] });
        const attempt = channels.create({ name: 'project', managerId, memberIds: [managerId] });

        await expect(attempt)
            .rejects.toThrow('already exists');
    });

    it('keeps the manager in the channel and removes a plain member', async () => {
        const channel = await channels.create({ name: 'Project', managerId, memberIds: [managerId, memberId] });
        const managerLeaves = channels.removeMember(channel.id, managerId);

        await expect(managerLeaves)
            .rejects.toThrow('cannot leave');

        await channels.removeMember(channel.id, memberId);

        const after = await channels.getById(channel.id);
        const remaining = after?.members.map(member => member.botId);

        expect(remaining)
            .toEqual([managerId]);
    });

    it('moves the manager role to another member in one step', async () => {
        const channel = await channels.create({ name: 'Project', managerId, memberIds: [managerId, memberId] });

        await channels.setManager(channel.id, memberId);

        const current = await channels.getById(channel.id);
        const members = current?.members ?? [];
        const managers = members.filter(member => member.isManager)
            .map(member => member.botId);

        expect(managers)
            .toEqual([memberId]);
    });

    it('refuses to make a bot outside the channel its manager', async () => {
        const channel = await channels.create({ name: 'Project', managerId, memberIds: [managerId] });
        const attempt = channels.setManager(channel.id, memberId);

        await expect(attempt)
            .rejects.toThrow('must be a member');
    });

    it('lists the channels a bot manages', async () => {
        await channels.create({ name: 'Project', managerId, memberIds: [managerId, memberId] });

        const managed = await channels.managedChannelNames(managerId);
        const memberManaged = await channels.managedChannelNames(memberId);

        expect(managed)
            .toEqual(['Project']);
        expect(memberManaged)
            .toEqual([]);
    });

    it('keeps the channel messages when their author bot is deleted', async () => {
        const channel = await channels.create({ name: 'Project', managerId, memberIds: [managerId, memberId] });

        await channels.appendMessage(channel.id, {
            authorBotId: memberId,
            authorName: 'Ben',
            authorColor: 'blue',
            authorShape: 'puff',
            authorEyes: 'smile',
            role: 'assistant',
            kind: 'text',
            body: { kind: 'text', text: 'Part two is done.' },
        });

        await bots.delete(memberId);

        const messages = await channels.listRecentMessages(channel.id, 10);
        const summary = messages.map(message => [message.authorName, message.authorBotId, message.body]);

        expect(summary)
            .toEqual([['Ben', undefined, { kind: 'text', text: 'Part two is done.' }]]);
    });

    it('returns the newest messages, oldest first', async () => {
        const channel = await channels.create({ name: 'Project', managerId, memberIds: [managerId] });
        const base = { authorBotId: managerId, authorName: 'Ana', authorColor: 'blue' as const, authorShape: 'puff' as const, authorEyes: 'smile' as const, role: 'user' as const, kind: 'text' };

        await channels.appendMessage(channel.id, { ...base, body: { kind: 'text', text: 'one' } });
        await channels.appendMessage(channel.id, { ...base, body: { kind: 'text', text: 'two' } });
        await channels.appendMessage(channel.id, { ...base, body: { kind: 'text', text: 'three' } });

        const recent = await channels.listRecentMessages(channel.id, 2);
        const bodies = recent.map(message => message.body);

        expect(bodies)
            .toEqual([{ kind: 'text', text: 'two' }, { kind: 'text', text: 'three' }]);
    });

    it('removes the channel messages with the channel', async () => {
        const channel = await channels.create({ name: 'Project', managerId, memberIds: [managerId] });

        await channels.appendMessage(channel.id, {
            authorBotId: managerId,
            authorName: 'Ana',
            authorColor: 'blue',
            authorShape: 'puff',
            authorEyes: 'smile',
            role: 'user',
            kind: 'text',
            body: { kind: 'text', text: 'Hi' },
        });
        await channels.deleteChannel(channel.id);

        const gone = await channels.getById(channel.id);
        const leftover = await channels.listRecentMessages(channel.id, 10);

        expect(gone)
            .toBeUndefined();
        expect(leftover)
            .toEqual([]);
    });

    it('refuses two channels whose names differ only in case, even when the creates race', async () => {
        const results = await Promise.allSettled([
            channels.create({ name: 'Launch', managerId, memberIds: [managerId] }),
            channels.create({ name: 'launch', managerId, memberIds: [managerId] }),
        ]);
        const rejected = results.filter(result => result.status === 'rejected');
        const created = await channels.list();

        expect(rejected)
            .toHaveLength(1);
        expect(rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined)
            .toBeInstanceOf(ChannelError);
        expect(created)
            .toHaveLength(1);
    });
});
