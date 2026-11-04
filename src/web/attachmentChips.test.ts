import { describe, expect, it } from 'vitest';

import { mergeLoadedUploads } from './attachmentChips.ts';

describe('mergeLoadedUploads', () => {
    it('keeps the chips still uploading and replaces the ready ones with the server list', () => {
        const chips = [
            { id: 'upload-1', name: 'uploading.txt', status: 'uploading' as const },
            { id: 'old-id', name: 'stale.txt', status: 'ready' as const },
        ];
        const uploads = [
            { id: 'server-id', name: 'kept.txt', mimeType: 'application/octet-stream', sizeBytes: 3 },
            { id: 'image-id', name: 'cat.png', mimeType: 'image/png', sizeBytes: 3 },
        ];
        const merged = mergeLoadedUploads(chips, uploads, 'bot 1');

        expect(merged)
            .toEqual([
                { id: 'upload-1', name: 'uploading.txt', status: 'uploading' },
                { id: 'server-id', name: 'kept.txt', status: 'ready' },
                { id: 'image-id', name: 'cat.png', status: 'ready', previewUrl: '/api/bots/bot%201/uploads/image-id' },
            ]);
    });
});
