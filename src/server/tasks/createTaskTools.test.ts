import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { TaskStore } from '../store/TaskStore.ts';
import { TASK_BLOCKED_NOTICE_PREFIX } from '../../shared/taskTypes.ts';
import type { TaskCard } from '../../shared/taskTypes.ts';
import { renderMarkdown } from '../../web/markdown.ts';

import { ADD_SHAPE, BOARD_CARD_LIMIT, MAX_TASKS_PER_BOT, MOVE_SHAPE, createTaskTools, describeBlockedNotice, describeBoard } from './createTaskTools.ts';

interface ToolResult {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;

interface BoardCall {
    cards: TaskCard[];
    hiddenCount: number;
}

describe('createTaskTools', () => {
    let opened: OpenedDatabase;
    let store: TaskStore;
    let botId: string;
    let otherBotId: string;
    let blockedCards: TaskCard[];
    let boardCalls: BoardCall[];
    let failBlockedNotice: boolean;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new TaskStore(opened.db);

        const botStore = new BotStore(opened.db);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const otherBot = await botStore.create({ name: 'Bia', title: 'Assistant', description: '' });

        botId = bot.id;
        otherBotId = otherBot.id;
        blockedCards = [];
        boardCalls = [];
        failBlockedNotice = false;
    });

    afterEach(() => {
        opened.close();
    });

    function findHandler(name: string, forBotId = botId): ToolHandler {
        const tools = createTaskTools(store, forBotId, {
            onBlocked: (card) => {
                if (failBlockedNotice) {
                    return Promise.reject(new Error('chat is down'));
                }

                blockedCards.push(card);

                return Promise.resolve();
            },
            onBoard: (cards, hiddenCount) => {
                boardCalls.push({ cards, hiddenCount });

                return Promise.resolve();
            },
        }) as unknown as { name: string; handler: unknown }[];
        const found = tools.find(candidate => candidate.name === name);

        if (found === undefined) {
            throw new Error(`No tool ${name}`);
        }

        return found.handler as ToolHandler;
    }

    function idFromAddReply(reply: ToolResult): string {
        const match = /id (\S+)\./.exec(reply.content[0]?.text ?? '');

        return match?.[1] ?? '';
    }

    it('adds a task to To do by default and lists it on the board', async () => {
        const reply = await findHandler('task_add')({ title: 'Write the report' }, undefined);
        const boardReply = await findHandler('task_board')({}, undefined);

        expect(reply.isError)
            .toBeUndefined();
        expect(boardCalls[0]?.cards)
            .toEqual([{ id: idFromAddReply(reply), title: 'Write the report', status: 'todo', blockedReason: null }]);
        expect(boardReply.content[0]?.text)
            .toContain('Write the report, To do');
    });

    it('refuses a move to Blocked without a reason and changes nothing', async () => {
        const task = await store.add(botId, 'Ship it', 'doing');
        const reply = await findHandler('task_move')({ id: task.id, status: 'blocked' }, undefined);

        expect(reply.isError)
            .toBe(true);
        expect(reply.content[0]?.text)
            .toBe('Say why the task is blocked. Pass a reason.');
        expect((await store.list(botId))[0]?.status)
            .toBe('doing');
        expect(blockedCards)
            .toEqual([]);
    });

    it('moves to Blocked with a reason, and tells the owner in the chat', async () => {
        const task = await store.add(botId, 'Ship it', 'doing');
        const reply = await findHandler('task_move')({ id: task.id, status: 'blocked', reason: 'Waiting for the API key' }, undefined);

        expect(reply.isError)
            .toBeUndefined();
        expect(blockedCards)
            .toEqual([{ id: task.id, title: 'Ship it', status: 'blocked', blockedReason: 'Waiting for the API key' }]);
    });

    it('does not notify again when a task that is already Blocked gets a new reason', async () => {
        const task = await store.add(botId, 'Ship it', 'todo');

        await findHandler('task_move')({ id: task.id, status: 'blocked', reason: 'Waiting' }, undefined);
        const reply = await findHandler('task_move')({ id: task.id, status: 'blocked', reason: 'Still waiting' }, undefined);

        expect(reply.isError)
            .toBeUndefined();
        expect(blockedCards)
            .toHaveLength(1);
        expect((await store.list(botId))[0])
            .toMatchObject({ status: 'blocked', blockedReason: 'Still waiting' });
    });

    it('keeps the move and tells the bot when the notice fails', async () => {
        const task = await store.add(botId, 'Ship it', 'doing');

        failBlockedNotice = true;
        const reply = await findHandler('task_move')({ id: task.id, status: 'blocked', reason: 'Waiting' }, undefined);

        expect(reply.content[0]?.text)
            .toContain('the notice in the chat failed');
        expect((await store.list(botId))[0])
            .toMatchObject({ status: 'blocked', blockedReason: 'Waiting' });
    });

    it('clears the reason when the task leaves Blocked', async () => {
        const task = await store.add(botId, 'Ship it', 'todo');

        await findHandler('task_move')({ id: task.id, status: 'blocked', reason: 'Waiting' }, undefined);
        await findHandler('task_move')({ id: task.id, status: 'doing', reason: 'Old reason' }, undefined);

        expect((await store.list(botId))[0])
            .toMatchObject({ status: 'doing', blockedReason: null });
        expect(blockedCards)
            .toHaveLength(1);
    });

    it('refuses to move a task that belongs to another bot', async () => {
        const task = await store.add(otherBotId, 'Not mine', 'todo');
        const reply = await findHandler('task_move')({ id: task.id, status: 'done' }, undefined);

        expect(reply)
            .toEqual({ content: [{ type: 'text', text: 'You have no task with this id.' }], isError: true });
        expect((await store.list(otherBotId))[0]?.status)
            .toBe('todo');
    });

    it('refuses a new task once the bot has the limit of tasks', async () => {
        const fillIns = Array.from({ length: MAX_TASKS_PER_BOT }, (_unused, index) => store.add(botId, `Task ${String(index)}`, 'todo'));

        await Promise.all(fillIns);
        const reply = await findHandler('task_add')({ title: 'One too many' }, undefined);

        expect(reply.isError)
            .toBe(true);
        expect(reply.content[0]?.text)
            .toBe('Your board has 100 open tasks. Finish one before you add more.');
        expect(await store.list(botId))
            .toHaveLength(MAX_TASKS_PER_BOT);
    });

    it('caps the cards of the board and says how many tasks are left out', async () => {
        const fillIns = Array.from({ length: BOARD_CARD_LIMIT + 10 }, (_unused, index) => store.add(botId, `Task ${String(index)}`, 'todo'));

        await Promise.all(fillIns);
        const reply = await findHandler('task_board')({}, undefined);

        expect(boardCalls[0]?.cards)
            .toHaveLength(BOARD_CARD_LIMIT);
        expect(boardCalls[0]?.hiddenCount)
            .toBe(10);
        expect(reply.content[0]?.text)
            .toContain('and 10 more');
    });

    it('refuses titles and reasons with line breaks or hidden characters', () => {
        const titleShape = z.object(ADD_SHAPE);
        const reasonShape = z.object(MOVE_SHAPE);

        expect(titleShape.safeParse({ title: 'Plain title' }).success)
            .toBe(true);
        expect(titleShape.safeParse({ title: 'Two\nlines' }).success)
            .toBe(false);
        expect(titleShape.safeParse({ title: 'Zero​width' }).success)
            .toBe(false);
        expect(reasonShape.safeParse({ id: 't', status: 'blocked', reason: 'Bidi‮override' }).success)
            .toBe(false);
    });

    it('writes the blocked notice with the bot prefix and the title and reason quoted', () => {
        const notice = describeBlockedNotice({ id: 't1', title: 'Ship it', status: 'blocked', blockedReason: 'No key' });

        expect(notice)
            .toBe(`${TASK_BLOCKED_NOTICE_PREFIX}"Ship it". Reason: "No key"`);
    });

    it('shows a link in a blocked notice as plain text', () => {
        const notice = describeBlockedNotice({ id: 't1', title: '[pay](https://evil.example)', status: 'blocked', blockedReason: 'see https://evil.example' });
        const html = renderMarkdown(notice);

        expect(html)
            .not.toContain('<a ');
        expect(html)
            .toContain('pay');
    });

    it('describes an empty board', () => {
        expect(describeBoard([], 0))
            .toBe('Your board has no tasks.');
    });

    it('shows the reason on the board line of a blocked task', () => {
        const line = describeBoard([{ id: 't1', title: 'Ship it', status: 'blocked', blockedReason: 'No key' }], 0);

        expect(line)
            .toBe('- t1: Ship it, Blocked (No key)');
    });
    it('lets a new task in when a finished task frees a place on the limit', async () => {
        const fillIns = Array.from({ length: MAX_TASKS_PER_BOT - 1 }, (_unused, index) => store.add(botId, `Open ${String(index)}`, 'todo'));

        await Promise.all(fillIns);
        await store.add(botId, 'Finished', 'done');
        const reply = await findHandler('task_add')({ title: 'One more open task' }, undefined);

        expect(reply.isError)
            .toBeUndefined();
        expect(await store.list(botId))
            .toHaveLength(MAX_TASKS_PER_BOT + 1);
    });

    it('shows open tasks first, newest first, and finished tasks last', async () => {
        let clock = 1000;

        store = new TaskStore(opened.db, { now: () => clock });
        await store.add(botId, 'Old finished', 'done');
        clock = 2000;
        await store.add(botId, 'Older open', 'todo');
        clock = 3000;
        await store.add(botId, 'Newer open', 'doing');
        await findHandler('task_board')({}, undefined);

        expect(boardCalls[0]?.cards.map(card => card.title))
            .toEqual(['Newer open', 'Older open', 'Old finished']);
    });

    it('takes the newest 50 open tasks onto the card, not the oldest', async () => {
        let clock = 1000;

        store = new TaskStore(opened.db, { now: () => clock });
        const indexes = Array.from({ length: BOARD_CARD_LIMIT + 5 }, (_unused, index) => index);

        await indexes.reduce(async (previous, index) => {
            await previous;
            clock += 1;
            await store.add(botId, `Task ${String(index)}`, 'todo');
        }, Promise.resolve());
        await findHandler('task_board')({}, undefined);

        expect(boardCalls[0]?.cards[0]?.title)
            .toBe(`Task ${String(BOARD_CARD_LIMIT + 4)}`);
        expect(boardCalls[0]?.hiddenCount)
            .toBe(5);
    });
});
