import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as FsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveFiles } from './saveUpload.ts';

// Makes the next write fail after three bytes, the way a full disk does.
const writeState = vi.hoisted(() => ({ failNextWrite: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    const open = async (...args: Parameters<typeof actual.open>): Promise<unknown> => {
        const handle = await actual.open(...args);

        return {
            writeFile: async (data: Buffer) => {
                if (!writeState.failNextWrite) {
                    return handle.writeFile(data);
                }

                writeState.failNextWrite = false;
                await handle.write(data.subarray(0, 3));

                throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
            },
            chmod: async (mode: number) => handle.chmod(mode),
            close: async () => handle.close(),
        };
    };

    return { ...actual, open };
});

describe('saveFiles with a write that fails midway', () => {
    let uploadDir: string;

    beforeEach(async () => {
        const root = await mkdtemp(join(tmpdir(), 'cloudbot-partial-'));

        uploadDir = join(root, 'bot-1');
    });

    afterEach(async () => {
        await rm(join(uploadDir, '..'), { recursive: true, force: true });
    });

    it('removes the partial file that was not returned', async () => {
        writeState.failNextWrite = true;

        await expect(saveFiles(uploadDir, [new File(['0123456789'], 'big.txt')]))
            .rejects.toThrow('no space left on device');
        expect(await readdir(uploadDir))
            .toEqual([]);
    });
});
