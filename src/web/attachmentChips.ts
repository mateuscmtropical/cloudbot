import type { PendingUpload } from '../shared/chatTypes.ts';
import { PREVIEW_IMAGE_TYPES } from '../shared/previewImageTypes.ts';
import type { DraftAttachment } from './components/Composer.tsx';

// Keeps the chips that are still uploading and replaces the rest with the files the server holds.
function mergeLoadedUploads(chips: DraftAttachment[], uploads: PendingUpload[], botId: string): DraftAttachment[] {
    const uploadingChips = chips.filter(chip => chip.status === 'uploading');
    const readyChips = uploads.map((upload) => {
        const previewUrl = PREVIEW_IMAGE_TYPES.has(upload.mimeType)
            ? `/api/bots/${encodeURIComponent(botId)}/uploads/${encodeURIComponent(upload.id)}`
            : undefined;

        return { id: upload.id, name: upload.name, status: 'ready' as const, previewUrl };
    });

    return [...uploadingChips, ...readyChips];
}

export { mergeLoadedUploads };
