// Records the microphone in browsers where speech recognition does not work, so the server can turn the audio into text.
interface VoiceRecording {
    // Settles with the audio after finish, or with an empty one after cancel. The microphone is off by then.
    audio: Promise<Blob>;
    finish: () => void;
    cancel: () => void;
}

// Enough for speech, and a five minute recording stays near one megabyte.
const AUDIO_BITS_PER_SECOND = 32_000;
const MAX_RECORDING_MS = 5 * 60 * 1000;
const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];

function canRecordVoice(): boolean {
    return typeof MediaRecorder === 'function' && 'mediaDevices' in navigator;
}

// Unset lets the browser pick. Safari only has mp4, and an older one has no isTypeSupported for some of these.
function pickRecordingType(isSupported: (type: string) => boolean): string | undefined {
    return RECORDING_TYPES.find(type => isSupported(type));
}

async function startVoiceRecording(): Promise<VoiceRecording> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickRecordingType(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, {
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
        ...(mimeType === undefined ? {} : { mimeType }),
    });
    const chunks: Blob[] = [];
    let isCancelled = false;

    recorder.addEventListener('dataavailable', (event) => {
        chunks.push(event.data);
    });

    const audio = new Promise<Blob>((resolve) => {
        recorder.addEventListener('stop', () => {
            const tracks = stream.getTracks();

            tracks.forEach((track) => {
                track.stop();
            });
            resolve(isCancelled ? new Blob() : new Blob(chunks, { type: recorder.mimeType }));
        });
    });

    function stopRecorder(): void {
        if (recorder.state !== 'inactive') {
            recorder.stop();
        }
    }

    const limitTimer = window.setTimeout(stopRecorder, MAX_RECORDING_MS);

    void audio.finally(() => {
        window.clearTimeout(limitTimer);
    });
    recorder.start();

    return {
        audio,
        finish: stopRecorder,
        cancel: () => {
            isCancelled = true;
            stopRecorder();
        },
    };
}

export { canRecordVoice, pickRecordingType, startVoiceRecording };
export type { VoiceRecording };
