import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChannelDetail, ChannelPostView, ChannelSummary } from '../../shared/channelTypes.ts';
import { BotStore } from '../store/BotStore.ts';
import { ChannelStore } from '../store/ChannelStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { createChannelRoutes } from './createChannelRoutes.ts';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('channel routes', () => {
    let opened: OpenedDatabase;
    let bots: BotStore;
    let channels: ChannelStore;
    let app: Hono;
    let channelId: string;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        bots = new BotStore(opened.db);
        channels = new ChannelStore(opened.db);
        app = new Hono();
        app.route('/', createChannelRoutes({ channels, bots }));

        const ana = await bots.create({ name: 'Ana', title: 'Manager', description: '' });
        const ben = await bots.create({ name: 'Ben', title: 'Helper', description: '' });
        const channel = await channels.create({ name: 'Project', managerId: ana.id, memberIds: [ana.id, ben.id] });

        channelId = channel.id;
    });

    afterEach(() => {
        opened.close();
    });

    it('lists each channel with its members, names and manager', async () => {
        const response = await app.request('/api/channels');
        const summaries = (await response.json()) as ChannelSummary[];

        expect(response.status)
            .toBe(200);
        expect(summaries[0]?.members.map(member => [member.name, member.isManager]))
            .toEqual(expect.arrayContaining([['Ana', true], ['Ben', false]]));
    });

    it('stores an owner post, and the channel view shows it with the owner name', async () => {
        const posted = await app.request(`/api/channels/${channelId}/messages`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text: '  Plan the sprint  ' }) });
        const post = (await posted.json()) as ChannelPostView;

        expect(posted.status)
            .toBe(201);
        expect(post.body)
            .toEqual({ kind: 'text', text: 'Plan the sprint' });

        const detail = await app.request(`/api/channels/${channelId}`);
        const view = (await detail.json()) as ChannelDetail;

        expect(view.messages.map(message => [message.authorName, message.role]))
            .toEqual([['You', 'user']]);
    });

    it('refuses an empty post with 400, and an unknown channel with 404', async () => {
        const empty = await app.request(`/api/channels/${channelId}/messages`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text: '   ' }) });
        const unknown = await app.request('/api/channels/missing');

        expect(empty.status)
            .toBe(400);
        expect(unknown.status)
            .toBe(404);
    });

    it('lets the owner make, change and delete a group, and speaks of a group in its refusals', async () => {
        const list = await bots.list();
        const ids = list.map(bot => bot.id);
        const managerId = ids[0];
        const created = await app.request('/api/channels', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Launch', memberIds: ids, managerId, isIsolated: true }) });
        const group = (await created.json()) as ChannelSummary;
        const taken = await app.request('/api/channels', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Project', memberIds: ids, managerId, isIsolated: false }) });
        const badShape = await app.request('/api/channels', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Solo' }) });
        const changed = await app.request(`/api/channels/${group.id}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Launch 2', memberIds: [managerId], managerId, isIsolated: false }) });
        const changedGroup = (await changed.json()) as ChannelSummary;
        const deleted = await app.request(`/api/channels/${group.id}`, { method: 'DELETE' });
        const gone = await app.request(`/api/channels/${group.id}`);

        expect(created.status)
            .toBe(201);
        expect(group.isIsolated)
            .toBe(true);
        expect(taken.status)
            .toBe(400);
        expect(await taken.json())
            .toEqual({ error: 'A group named Project already exists.' });
        expect(badShape.status)
            .toBe(400);
        expect([changedGroup.name, changedGroup.isIsolated, changedGroup.members.length])
            .toEqual(['Launch 2', false, 1]);
        expect(deleted.status)
            .toBe(204);
        expect(gone.status)
            .toBe(404);
    });

    it('accepts a post of 4000 characters and refuses one longer', async () => {
        const atLimit = await app.request(`/api/channels/${channelId}/messages`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text: 'a'.repeat(4000) }) });
        const overLimit = await app.request(`/api/channels/${channelId}/messages`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text: 'a'.repeat(4001) }) });

        expect(atLimit.status)
            .toBe(201);
        expect(overLimit.status)
            .toBe(400);
        expect(await overLimit.json())
            .toEqual({ error: 'A post can have at most 4000 characters.' });
    });
});
