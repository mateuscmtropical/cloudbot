import { describe, expect, it } from 'vitest';

import { mapCodexNotification, mapCodexTurnEnd } from './mapCodexNotification.ts';

describe('mapCodexNotification', () => {
    it('streams the reply and repeats it in full when the message is done', () => {
        expect(mapCodexNotification('item/agentMessage/delta', { itemId: 'm', delta: 'Hel' }))
            .toEqual([{ type: 'text_delta', text: 'Hel' }]);
        expect(mapCodexNotification('item/completed', { item: { type: 'agentMessage', id: 'm', text: 'Hello' } }))
            .toEqual([{ type: 'text', text: 'Hello' }]);
    });

    it('shows a command as one Bash row, with the command out of its login shell', () => {
        const started = mapCodexNotification('item/started', { item: { type: 'commandExecution', id: 'call_1', command: '/bin/bash -lc \'echo hi\'', status: 'inProgress', aggregatedOutput: null, exitCode: null } });
        const finished = mapCodexNotification('item/completed', { item: { type: 'commandExecution', id: 'call_1', command: '/bin/bash -lc \'echo hi\'', status: 'completed', aggregatedOutput: 'hi\n', exitCode: 0 } });

        expect(started)
            .toEqual([{ type: 'tool_started', toolUseId: 'call_1', toolName: 'Bash', input: { command: 'echo hi' } }]);
        expect(finished)
            .toEqual([{ type: 'tool_finished', toolUseId: 'call_1', isError: false, output: 'hi\n' }]);
    });

    it('marks a declined command and a failing exit code as errors', () => {
        const declined = mapCodexNotification('item/completed', { item: { type: 'commandExecution', id: 'a', command: 'ls', status: 'declined', aggregatedOutput: null, exitCode: null } });
        const failed = mapCodexNotification('item/completed', { item: { type: 'commandExecution', id: 'b', command: 'false', status: 'completed', aggregatedOutput: '', exitCode: 1 } });

        expect(declined)
            .toEqual([{ type: 'tool_finished', toolUseId: 'a', isError: true, output: 'declined' }]);
        expect(failed)
            .toMatchObject([{ isError: true }]);
    });

    it('shows a file change as an Edit row with its paths', () => {
        const started = mapCodexNotification('item/started', { item: { type: 'fileChange', id: 'p', status: 'inProgress', changes: [{ path: '/w/a.txt', kind: { type: 'add' }, diff: 'a' }] } });

        expect(started)
            .toEqual([{ type: 'tool_started', toolUseId: 'p', toolName: 'Edit', input: { files: ['/w/a.txt'] } }]);
    });

    it('reads any other notification as activity only', () => {
        expect(mapCodexNotification('thread/tokenUsage/updated', {}))
            .toEqual([{ type: 'activity' }]);
        expect(mapCodexNotification('item/started', { item: { type: 'reasoning', id: 'r' } }))
            .toEqual([{ type: 'activity' }]);
        expect(mapCodexNotification('item/started', { item: 'not an item' }))
            .toEqual([{ type: 'activity' }]);
    });
});

describe('mapCodexTurnEnd', () => {
    it('finishes a completed turn, ends a stopped one quietly and reports a usage limit', () => {
        expect(mapCodexTurnEnd({ id: 't', status: 'completed', error: null, durationMs: 120 }))
            .toEqual([{ type: 'turn_finished', durationMs: 120 }]);
        expect(mapCodexTurnEnd({ id: 't', status: 'interrupted', error: null, durationMs: null }))
            .toEqual([]);
        expect(mapCodexTurnEnd({ id: 't', status: 'failed', error: { message: 'You hit your limit.', codexErrorInfo: 'usageLimitExceeded' }, durationMs: null }))
            .toEqual([{ type: 'turn_error', message: 'You hit your limit.', isUsageLimit: true }]);
        expect(mapCodexTurnEnd({ id: 't', status: 'failed', error: null, durationMs: null }))
            .toEqual([{ type: 'turn_error', message: 'The Codex turn failed.', isUsageLimit: false }]);
    });
});
