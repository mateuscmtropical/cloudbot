import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ActionLog, RETENTION_DAYS, logReviews } from './ActionLog.ts';

const SIGNAL = new AbortController().signal;
const SECRET_INPUT = { text: 'private words' };

function makeLogPath(): string {
    const folder = mkdtempSync(join(tmpdir(), 'cloudbot-action-log-'));

    return join(folder, 'actions.log');
}

function readEntries(filePath: string): Record<string, unknown>[] {
    const text = readFileSync(filePath, 'utf8');
    const lines = text.split('\n')
        .filter(line => line !== '');

    return lines.map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('ActionLog', () => {
    it('writes one JSON line per action, with the time', () => {
        const filePath = makeLogPath();
        const log = new ActionLog(filePath);

        log.write({ botId: 'bot-1', event: 'tool_finished', tool: 'Read', isError: false });

        const entries = readEntries(filePath);

        expect(entries)
            .toMatchObject([{ botId: 'bot-1', event: 'tool_finished', tool: 'Read', isError: false }]);
        expect(typeof entries[0]?.at)
            .toBe('string');
    });

    it('keeps one old file when the log grows past its limit', () => {
        const filePath = makeLogPath();
        const log = new ActionLog(filePath, 10);

        log.write({ botId: 'first', event: 'turn_error' });
        log.write({ botId: 'second', event: 'turn_error' });

        expect(existsSync(`${filePath}.1`))
            .toBe(true);
        expect(readEntries(filePath))
            .toMatchObject([{ botId: 'second' }]);
    });

    it('reads the newest entries first from both files, for one bot when asked', () => {
        const filePath = makeLogPath();
        const log = new ActionLog(filePath, 10);

        log.write({ botId: 'first', event: 'turn_error' });
        log.write({ botId: 'second', event: 'turn_error' });

        const everyBot = log.read(2);
        const oneBot = log.read(10, 'first');

        expect(everyBot)
            .toMatchObject([{ botId: 'second' }, { botId: 'first' }]);
        expect(oneBot)
            .toMatchObject([{ botId: 'first' }]);
    });

    it('drops what passed the retention from both files and keeps the rest', () => {
        const filePath = makeLogPath();
        const startTime = Date.parse('2026-01-01T00:00:00.000Z');
        const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const clock = { time: startTime };
        // Two lines fit under the limit, so the third moves both to the old file.
        const log = new ActionLog(filePath, 100, () => clock.time);

        log.write({ botId: 'too-old', event: 'turn_error' });
        clock.time = startTime + retentionMs - 1000;
        log.write({ botId: 'fresh-in-old-file', event: 'turn_error' });
        log.write({ botId: 'fresh', event: 'turn_error' });
        clock.time = startTime + retentionMs + 1;

        const visible = log.read(10);
        const visibleBots = visible.map(entry => entry.botId);

        expect(visibleBots)
            .toEqual(['fresh', 'fresh-in-old-file']);

        log.prune();

        expect(readEntries(`${filePath}.1`))
            .toMatchObject([{ botId: 'fresh-in-old-file' }]);
        expect(readEntries(filePath))
            .toMatchObject([{ botId: 'fresh' }]);
    });

    it('removes a file when nothing in it is fresh', () => {
        const filePath = makeLogPath();
        const clock = { time: Date.parse('2026-01-01T00:00:00.000Z') };
        const log = new ActionLog(filePath, undefined, () => clock.time);

        log.write({ botId: 'old', event: 'turn_error' });
        clock.time += (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
        log.prune();

        expect(existsSync(filePath))
            .toBe(false);
    });

    it('never throws when the file cannot be written', () => {
        const errorSpy = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const log = new ActionLog(join(tmpdir(), 'no-such-folder-for-cloudbot', 'actions.log'));

        expect(() => {
            log.write({ botId: 'bot-1', event: 'turn_error' });
        }).not.toThrow();
        errorSpy.mockRestore();
    });
});

describe('logReviews', () => {
    it.each([
        [{ isAllowed: true as const }, 'allowed'],
        [{ isAllowed: false as const, reason: 'private reason' }, 'refused'],
        [{ isAllowed: false as const, reason: 'private reason', isOwnerDenial: true }, 'owner_denied'],
    ])('notes the outcome and never the input or the reason: %j', async (decision, expected) => {
        const filePath = makeLogPath();
        const review = logReviews(() => Promise.resolve(decision), new ActionLog(filePath), 'bot-1');

        await expect(review({ toolName: 'mcp__cloudbot__browser_open', input: SECRET_INPUT }, SIGNAL))
            .resolves.toEqual(decision);

        const text = readFileSync(filePath, 'utf8');

        expect(readEntries(filePath))
            .toMatchObject([{ botId: 'bot-1', event: 'review', tool: 'mcp__cloudbot__browser_open', decision: expected }]);
        expect(text).not.toContain('private');
    });

    it('keeps who decided, the card line and the reason, cut short and without card numbers', async () => {
        const filePath = makeLogPath();
        const review = logReviews((_call, _signal, note) => {
            Object.assign(note ?? {}, { decision: 'blocked', decidedBy: 'block list', summary: `Pay 4111 1111 1111 1111 ${'x'.repeat(300)}`, reason: 'No.' });

            return Promise.resolve({ isAllowed: false as const, reason: 'No.' });
        }, new ActionLog(filePath), 'bot-1', 'channel-1');

        await review({ toolName: 'Bash', input: SECRET_INPUT }, SIGNAL);

        const [entry] = readEntries(filePath);

        expect(entry)
            .toMatchObject({ decision: 'blocked', decidedBy: 'block list', reason: 'No.', channelId: 'channel-1' });
        expect(String(entry?.summary))
            .not.toContain('4111 1111');
        expect(String(entry?.summary).length)
            .toBeLessThanOrEqual(203);
    });

    it('filters by decision and start time when it reads', () => {
        const filePath = makeLogPath();
        const log = new ActionLog(filePath);

        log.write({ botId: 'bot-1', event: 'review', decision: 'blocked' });
        log.write({ botId: 'bot-1', event: 'review', decision: 'allowed' });

        expect(log.read(10, undefined, 'blocked'))
            .toMatchObject([{ decision: 'blocked' }]);
        expect(log.read(10, undefined, undefined, Date.now() + 60_000))
            .toEqual([]);
    });

    it('notes a review that throws, and throws it on', async () => {
        const filePath = makeLogPath();
        const review = logReviews(() => Promise.reject(new Error('down')), new ActionLog(filePath), 'bot-1');

        await expect(review({ toolName: 'Bash', input: {} }, SIGNAL))
            .rejects.toThrow('down');
        expect(readEntries(filePath))
            .toMatchObject([{ decision: 'review_failed' }]);
    });
});
