import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WRAPPER_PATH = fileURLToPath(new URL('../../../docker/cloudbot-signal-group', import.meta.url));

// The wrapper runs as root's root-owned copy in the image. Its exit codes: 2 for a bad argument, the kill status otherwise.
function runWrapper(args: string[]): number | null {
    return spawnSync('sh', [WRAPPER_PATH, ...args], { encoding: 'utf8' }).status;
}

describe.skipIf(process.platform === 'win32')('cloudbot-signal-group', () => {
    it.each([
        ['no arguments', []],
        ['one argument', ['1']],
        ['three arguments', ['1', 'KILL', 'extra']],
    ])('rejects %s', (_label, args) => {
        expect(runWrapper(args))
            .toBe(2);
    });

    it.each([
        ['group zero', ['0', 'KILL']],
        ['a name for the group', ['abc', 'KILL']],
        ['a negative group', ['-1', 'KILL']],
        ['a leading zero', ['012', 'TERM']],
        ['a signal other than TERM or KILL', ['1', 'HUP']],
        ['a signal with a dash', ['1', '-KILL']],
        ['a shell fragment in the group', ['1; id', 'KILL']],
    ])('rejects %s', (_label, args) => {
        expect(runWrapper(args))
            .toBe(2);
    });

    it('passes a valid group and signal to kill, which fails here because no such group exists', () => {
        expect(runWrapper(['2147483646', 'TERM']))
            .toBe(1);
    });
});
