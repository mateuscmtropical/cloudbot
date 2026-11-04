import { useCallback, useEffect, useRef, useState } from 'react';

import { RequestFailedError, transcribeVoice } from './apiClient.ts';
import { canRecordVoice, startVoiceRecording } from './voiceRecorder.ts';
import type { VoiceRecording } from './voiceRecorder.ts';

// The browser's own speech recognition comes first, as Chrome and Edge send the audio to their speech service and the app
// never receives it. A browser without a working service records instead, and the server turns the recording into text.
interface SpeechAlternative {
    transcript: string;
}

interface SpeechResultEvent {
    readonly results: ArrayLike<ArrayLike<SpeechAlternative>>;
}

interface SpeechErrorEvent {
    readonly error: string;
}

interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onstart: (() => void) | null;
    onresult: ((event: SpeechResultEvent) => void) | null;
    onerror: ((event: SpeechErrorEvent) => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
    abort: () => void;
}

interface SpeechRecognitionConstructor {
    new (): SpeechRecognitionLike;
}

interface SpeechWindow {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

interface VoiceInputOptions {
    // The browser language, such as "pt-BR". The recognizer listens in this language.
    language: string;
    // Runs when listening starts, before any text arrives, so the caller can keep the text it already has.
    onStart: () => void;
    // Gets the words heard so far in this listening session. Interim words replace earlier interim words.
    onTranscript: (transcript: string) => void;
}

type VoiceMode = 'idle' | 'listening' | 'recording' | 'transcribing';

interface RecordingJob {
    controller: AbortController;
    // Unset until the browser turned the microphone on.
    recording?: VoiceRecording;
}

interface VoiceInput {
    isListening: boolean;
    // A finished recording is on its way to the server.
    isTranscribing: boolean;
    // A short message about the last listening session, or undefined when there is nothing to show.
    statusText: string | undefined;
    toggle: () => void;
    // Ends listening at once. Words that are still being heard are dropped, so they never reach the draft.
    stopListening: () => void;
}

const DEFAULT_LANGUAGE = 'en-US';
const STATUS_SHOW_MS = 4000;
const NO_SERVICE_STATUS = 'The speech service could not be reached.';
const SPEECH_ERROR_MESSAGES = new Map<string, string>([
    ['not-allowed', 'Microphone access was denied.'],
    ['service-not-allowed', 'Microphone access was denied.'],
    ['audio-capture', 'No microphone was found.'],
    ['no-speech', 'No speech was heard.'],
    ['network', NO_SERVICE_STATUS],
    ['language-not-supported', 'The speech service does not know this language.'],
]);
// The API exists but nothing answers behind it, which is the case in some Chromium browsers.
const NO_SERVICE_ERRORS = new Set(['network', 'service-not-allowed', 'language-not-supported']);

function findSpeechRecognition(speechWindow: SpeechWindow): SpeechRecognitionConstructor | undefined {
    return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

// An empty or missing browser language falls back to English, so the recognizer always has a language.
function speechLanguage(browserLanguage: string | undefined): string {
    const trimmedLanguage = browserLanguage?.trim() ?? '';

    return trimmedLanguage === '' ? DEFAULT_LANGUAGE : trimmedLanguage;
}

// Joins the results of one listening session. Chrome may split one phrase into several results.
// In continuous mode Chrome on Android repeats the earlier words at the start of each new result, so a result that
// starts with the one before it takes its place.
function transcriptOf(event: SpeechResultEvent): string {
    const pieces = Array.from(event.results, result => result[0]?.transcript.trim() ?? '');
    const kept = pieces.filter(piece => piece !== '')
        .reduce<string[]>((joined, piece) => {
            const previous = joined.at(-1);

            return previous !== undefined && piece.startsWith(previous) ? [...joined.slice(0, -1), piece] : [...joined, piece];
        }, []);

    return kept.join(' ');
}

// The text the owner typed before listening stays, and the spoken words follow it.
function joinVoiceText(typedBeforeListening: string, spokenText: string): string {
    const typed = typedBeforeListening.trimEnd();

    return typed === '' ? spokenText : `${typed} ${spokenText}`;
}

// A stop by the owner is not an error, so it shows nothing. Other errors get a short sentence.
function describeSpeechError(error: string): string | undefined {
    if (error === 'aborted') {
        return undefined;
    }

    return SPEECH_ERROR_MESSAGES.get(error) ?? 'Voice input stopped.';
}

const MODE_STATUS = new Map<VoiceMode, string>([
    ['listening', 'Listening. Speak now.'],
    ['recording', 'Recording. Press again to finish.'],
    ['transcribing', 'Turning your recording into text.'],
]);
const NO_SPEECH_STATUS = 'No speech was heard.';
const START_FAILED_STATUS = 'Voice input could not start.';
const NEEDS_HTTPS_STATUS = 'Voice input needs a secure connection (HTTPS).';
const NOT_AVAILABLE_STATUS = 'This browser cannot record voice. Try Chrome, Edge or Safari.';
const TRANSCRIBE_FAILED_STATUS = 'The recording could not be turned into text.';
// A recognizer that ends this fast is not hearing anything, so starting it again would only loop.
const MIN_SESSION_MS = 1000;

function readClock(): number {
    return Date.now();
}

function describeRecordingError(error: unknown): string {
    if (error instanceof RequestFailedError) {
        return error.serverMessage ?? TRANSCRIBE_FAILED_STATUS;
    }

    if (error instanceof DOMException && error.name === 'NotAllowedError') {
        return SPEECH_ERROR_MESSAGES.get('not-allowed') ?? START_FAILED_STATUS;
    }

    if (error instanceof DOMException && error.name === 'NotFoundError') {
        return SPEECH_ERROR_MESSAGES.get('audio-capture') ?? START_FAILED_STATUS;
    }

    return START_FAILED_STATUS;
}

function useVoiceInput(options: VoiceInputOptions): VoiceInput {
    const [mode, setMode] = useState<VoiceMode>('idle');
    const [errorText, setErrorText] = useState<string | undefined>(undefined);
    const recognitionRef = useRef<SpeechRecognitionLike | undefined>(undefined);
    const recordingJobRef = useRef<RecordingJob | undefined>(undefined);
    // The owner pressed stop, so the end of the recognizer ends the session instead of starting it again.
    const isStoppingRef = useRef(false);
    // This browser has the API but no speech service behind it. Later presses go straight to the recording.
    const usesRecordingRef = useRef(false);
    // The newest callbacks are read when they are needed, so a session never calls an old one.
    const optionsRef = useRef(options);

    useEffect(() => {
        optionsRef.current = options;
    });

    useEffect(() => {
        if (errorText === undefined) {
            return;
        }

        const timer = window.setTimeout(() => {
            setErrorText(undefined);
        }, STATUS_SHOW_MS);

        return () => {
            window.clearTimeout(timer);
        };
    }, [errorText]);

    // Stable, so an effect that depends on it does not stop listening on every render.
    const stopListening = useCallback((): void => {
        const recognition = recognitionRef.current;
        const job = recordingJobRef.current;

        recognitionRef.current = undefined;
        recordingJobRef.current = undefined;
        recognition?.abort();
        job?.controller.abort();
        job?.recording?.cancel();
        setMode('idle');
    }, []);

    useEffect(() => stopListening, [stopListening]);

    async function runRecordingJob(job: RecordingJob): Promise<void> {
        try {
            const recording = await startVoiceRecording();

            // The owner left while the browser asked for the microphone.
            if (recordingJobRef.current !== job) {
                recording.cancel();

                return;
            }

            job.recording = recording;

            const audio = await recording.audio;

            if (recordingJobRef.current !== job) {
                return;
            }

            setMode('transcribing');

            const language = speechLanguage(optionsRef.current.language);
            const text = await transcribeVoice(audio, language, job.controller.signal);

            if (recordingJobRef.current !== job) {
                return;
            }

            if (text === '') {
                setErrorText(NO_SPEECH_STATUS);
            } else {
                optionsRef.current.onTranscript(text);
            }
        } catch (error: unknown) {
            if (recordingJobRef.current === job) {
                const message = describeRecordingError(error);

                setErrorText(message);
            }
        } finally {
            if (recordingJobRef.current === job) {
                recordingJobRef.current = undefined;
                setMode('idle');
            }
        }
    }

    function startRecordingJob(): void {
        if (!canRecordVoice()) {
            setErrorText(window.isSecureContext ? NOT_AVAILABLE_STATUS : NEEDS_HTTPS_STATUS);

            return;
        }

        const job: RecordingJob = { controller: new AbortController() };

        recordingJobRef.current = job;
        setErrorText(undefined);
        setMode('recording');
        void runRecordingJob(job);
    }

    // One recognizer ends after a while even in continuous mode, so a new one takes over with the words heard so far.
    function listen(speechClass: SpeechRecognitionConstructor, heardBefore: string): void {
        const recognition = new speechClass();
        const startedAt = readClock();
        let heardNow = '';
        let hasStarted = false;
        let isFailed = false;
        let needsRecording = false;

        recognition.lang = speechLanguage(optionsRef.current.language);
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.onstart = () => {
            hasStarted = true;
        };
        // A recognizer that was stopped or replaced is no longer this session, so its late events are ignored.
        recognition.onresult = (event) => {
            if (recognitionRef.current !== recognition) {
                return;
            }

            heardNow = transcriptOf(event);

            const transcript = joinVoiceText(heardBefore, heardNow);

            optionsRef.current.onTranscript(transcript);
        };
        recognition.onerror = (event) => {
            const message = describeSpeechError(event.error);

            if (recognitionRef.current !== recognition || message === undefined) {
                return;
            }

            isFailed = true;
            // Nothing was heard and the service is out of reach, so the server does the work instead.
            needsRecording = NO_SERVICE_ERRORS.has(event.error) && heardBefore === '' && heardNow === '' && canRecordVoice();

            if (!needsRecording) {
                setErrorText(message);
            }
        };
        recognition.onend = () => {
            if (recognitionRef.current !== recognition) {
                return;
            }

            recognitionRef.current = undefined;

            // Opera has the API, but it ends at once with no error and never starts.
            const neverStarted = !hasStarted && !isFailed && !isStoppingRef.current && heardNow === '';

            if (neverStarted && !canRecordVoice()) {
                setErrorText(NO_SERVICE_STATUS);
            }

            if (needsRecording || (neverStarted && canRecordVoice())) {
                usesRecordingRef.current = true;
                startRecordingJob();

                return;
            }

            const ranLongEnough = readClock() - startedAt >= MIN_SESSION_MS;

            if (!isFailed && !isStoppingRef.current && ranLongEnough) {
                const heardSoFar = joinVoiceText(heardBefore, heardNow);

                listen(speechClass, heardSoFar);

                return;
            }

            setMode('idle');
        };

        recognitionRef.current = recognition;

        try {
            recognition.start();
        } catch {
            recognitionRef.current = undefined;
            setMode('idle');
            setErrorText(START_FAILED_STATUS);
        }
    }

    function start(): void {
        const speechClass = findSpeechRecognition(globalThis as SpeechWindow);

        optionsRef.current.onStart();

        if (speechClass === undefined || usesRecordingRef.current) {
            startRecordingJob();

            return;
        }

        isStoppingRef.current = false;
        setErrorText(undefined);
        setMode('listening');
        listen(speechClass, '');
    }

    function toggle(): void {
        const job = recordingJobRef.current;

        if (job !== undefined) {
            // Before the microphone is on there is nothing to send, so the press only cancels.
            if (job.recording === undefined) {
                stopListening();
            } else {
                job.recording.finish();
            }

            return;
        }

        if (recognitionRef.current !== undefined) {
            isStoppingRef.current = true;
            recognitionRef.current.stop();

            return;
        }

        start();
    }

    const statusText = errorText ?? MODE_STATUS.get(mode);

    return { isListening: mode === 'listening' || mode === 'recording', isTranscribing: mode === 'transcribing', statusText, toggle, stopListening };
}

export { findSpeechRecognition, describeRecordingError, describeSpeechError, joinVoiceText, speechLanguage, transcriptOf, useVoiceInput };
export type { SpeechAlternative, SpeechErrorEvent, SpeechRecognitionConstructor, SpeechRecognitionLike, SpeechResultEvent, SpeechWindow, VoiceInput, VoiceInputOptions };
