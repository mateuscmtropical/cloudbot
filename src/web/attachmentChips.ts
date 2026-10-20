import type { PendingUpload } from '../shared/chatTypes.ts';
import type { DraftAttachment } from './components/Composer.tsx';

// Keeps the chips that are still uploading and replaces the rest with the files the server holds.
function mergeLoadedUploads(chips: DraftAttachment[], uploads: PendingUpload[]): DraftAttachment[] {
    const uploadingChips = chips.filter(chip => chip.status === 'uploading');
    const readyChips = uploads.map(upload => ({ id: upload.id, name: upload.name, status: 'ready' as const }));

    return [...uploadingChips, ...readyChips];
}

export { mergeLoadedUploads };
