import type { ReactElement } from 'react';

import type { DraftAttachment } from './Composer.tsx';
import { FileIcon } from './icons.tsx';

interface AttachmentTrayProps {
    attachments: DraftAttachment[];
    onRemove: (attachmentId: string) => void;
}

// The files waiting for the next message, as small squares. Each one is removed on its own.
function AttachmentTray({ attachments, onRemove }: AttachmentTrayProps): ReactElement | null {
    if (attachments.length === 0) {
        return null;
    }

    return (
        <ul className="attachment-tray" aria-label="Attached files">
            {attachments.map(attachment => (
                <li key={attachment.id} className="attachment-thumb" title={attachment.name}>
                    {attachment.previewUrl === undefined
                        ? (
                                <>
                                    <FileIcon />
                                    <span className="attachment-thumb-name">{attachment.name}</span>
                                </>
                            )
                        : <img src={attachment.previewUrl} alt={attachment.name} decoding="async" />}
                    {attachment.status === 'uploading'
                        ? <span className="attachment-thumb-spinner" role="status" aria-label={`Uploading ${attachment.name}`} />
                        : (
                                <button
                                    type="button"
                                    className="attachment-remove"
                                    aria-label={`Remove ${attachment.name}`}
                                    onClick={() => {
                                        onRemove(attachment.id);
                                    }}
                                >
                                    &times;
                                </button>
                            )}
                </li>
            ))}
        </ul>
    );
}

export { AttachmentTray };
export type { AttachmentTrayProps };
