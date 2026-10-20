import { describe, expect, it } from 'vitest';

import { mergeLoadedUploads } from './attachmentChips.ts';

describe('mergeLoadedUploads', () => {
    it('keeps the chips still uploading and replaces the ready ones with the server list', () => {
        const chips = [
            { id: 'upload-1', name: 'uploading.txt', status: 'uploading' as const },
            { id: 'old-id', name: 'stale.txt', status: 'ready' as const },
        ];
        const merged = mergeLoadedUploads(chips, [{ id: 'server-id', name: 'kept.txt', sizeBytes: 3 }]);

        expect(merged)
            .toEqual([
                { id: 'upload-1', name: 'uploading.txt', status: 'uploading' },
                { id: 'server-id', name: 'kept.txt', status: 'ready' },
            ]);
    });
});
