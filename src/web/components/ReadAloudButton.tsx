import type { ReactElement } from 'react';

import { canReadAloud, readAloud, stopReading, useSpeakingId } from '../readAloud.ts';
import { SpeakerIcon } from './icons.tsx';

interface ReadAloudButtonProps {
    messageId: string;
    text: string;
}

function ReadAloudButton({ messageId, text }: ReadAloudButtonProps): ReactElement | null {
    const speakingId = useSpeakingId();
    const isReading = speakingId === messageId;

    if (!canReadAloud()) {
        return null;
    }

    return (
        <button
            type="button"
            className={isReading ? 'read-aloud-button is-reading' : 'read-aloud-button'}
            aria-label={isReading ? 'Stop reading' : 'Read aloud'}
            title={isReading ? 'Stop reading' : 'Read aloud'}
            aria-pressed={isReading}
            onClick={() => {
                if (isReading) {
                    stopReading();
                } else {
                    readAloud(messageId, text);
                }
            }}
        >
            <SpeakerIcon />
        </button>
    );
}

export { ReadAloudButton };
export type { ReadAloudButtonProps };
