import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ActionLog, logReviews } from './ActionLog.ts';

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

    it('notes a review that throws, and throws it on', async () => {
        const filePath = makeLogPath();
        const review = logReviews(() => Promise.reject(new Error('down')), new ActionLog(filePath), 'bot-1');

        await expect(review({ toolName: 'Bash', input: {} }, SIGNAL))
            .rejects.toThrow('down');
        expect(readEntries(filePath))
            .toMatchObject([{ decision: 'review_failed' }]);
    });
});
