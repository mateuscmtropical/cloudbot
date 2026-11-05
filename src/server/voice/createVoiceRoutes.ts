import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { readMaxUploadBytes } from '../attachments/saveUpload.ts';
import { readUploadedFiles } from '../chat/createChatRoutes.ts';
import { VoiceBusyError, VoiceFormatError, VoiceUnavailableError } from './transcribeAudio.ts';
import type { TranscribeAudio } from './transcribeAudio.ts';

interface VoiceRoutesOptions {
    transcribe: TranscribeAudio;
    maxUploadBytes?: number | undefined;
}

const NO_AUDIO = { error: 'Send one audio file.' };
const TOO_LARGE = { error: 'The recording is too long.' };
const FAILED = { error: 'The recording could not be transcribed.' };

// The session and origin checks of /api/* run first, as for an upload. The audio is deleted when the job ends.
function createVoiceRoutes(options: VoiceRoutesOptions): Hono {
    const routes = new Hono();
    const maxSize = options.maxUploadBytes ?? readMaxUploadBytes({});
    const tooLarge = (context: Context): Response => context.json(TOO_LARGE, 413);

    const uploadLimit = bodyLimit({ maxSize, onError: tooLarge });

    routes.post('/api/voice/transcribe', uploadLimit, async (context) => {
        const files = await readUploadedFiles(context);
        const audioFile = files[0];

        if (audioFile === undefined || files.length > 1) {
            return context.json(NO_AUDIO, 400);
        }

        const arrayBuffer = await audioFile.arrayBuffer();
        const audio = Buffer.from(arrayBuffer);
        const language = context.req.query('language');

        try {
            const text = await options.transcribe(audio, language);

            return context.json({ text });
        } catch (error: unknown) {
            if (error instanceof VoiceFormatError) {
                return context.json({ error: error.message }, 415);
            }

            if (error instanceof VoiceBusyError) {
                return context.json({ error: error.message }, 429);
            }

            if (error instanceof VoiceUnavailableError) {
                return context.json({ error: error.message }, 503);
            }

            console.error('Voice transcription failed.');

            return context.json(FAILED, 500);
        }
    });

    return routes;
}

export { createVoiceRoutes };
export type { VoiceRoutesOptions };
