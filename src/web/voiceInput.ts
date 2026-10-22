import { useCallback, useEffect, useRef, useState } from 'react';

// The browser's own speech recognition. Chrome and Edge send the audio to their speech service, so the
// app never receives or stores any audio.
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

interface VoiceInput {
    isSupported: boolean;
    isListening: boolean;
    // A short message about the last listening session, or undefined when there is nothing to show.
    statusText: string | undefined;
    toggle: () => void;
    // Ends listening at once. Words that are still being heard are dropped, so they never reach the draft.
    stopListening: () => void;
}

const DEFAULT_LANGUAGE = 'en-US';
const STATUS_SHOW_MS = 4000;
const SPEECH_ERROR_MESSAGES = new Map<string, string>([
    ['not-allowed', 'Microphone access was denied.'],
    ['service-not-allowed', 'Microphone access was denied.'],
    ['audio-capture', 'No microphone was found.'],
    ['no-speech', 'No speech was heard.'],
    ['network', 'The speech service could not be reached.'],
]);

function findSpeechRecognition(speechWindow: SpeechWindow): SpeechRecognitionConstructor | undefined {
    return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

// An empty or missing browser language falls back to English, so the recognizer always has a language.
function speechLanguage(browserLanguage: string | undefined): string {
    const trimmedLanguage = browserLanguage?.trim() ?? '';

    return trimmedLanguage === '' ? DEFAULT_LANGUAGE : trimmedLanguage;
}

// Joins the results of one listening session. Chrome may split one phrase into several results.
function transcriptOf(event: SpeechResultEvent): string {
    const pieces = Array.from(event.results, result => result[0]?.transcript.trim() ?? '');

    return pieces.filter(piece => piece !== '')
        .join(' ');
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

const LISTENING_STATUS = 'Listening. Speak now.';
const START_FAILED_STATUS = 'Voice input could not start.';

function useVoiceInput(options: VoiceInputOptions): VoiceInput {
    const [isListening, setIsListening] = useState(false);
    const [errorText, setErrorText] = useState<string | undefined>(undefined);
    const recognitionRef = useRef<SpeechRecognitionLike | undefined>(undefined);
    // The newest callbacks are read when they are needed, so a session never calls an old one.
    const optionsRef = useRef(options);
    const isSupported = findSpeechRecognition(globalThis as SpeechWindow) !== undefined;

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

    useEffect(() => {
        return () => {
            recognitionRef.current?.abort();
        };
    }, []);

    function start(): void {
        const speechClass = findSpeechRecognition(globalThis as SpeechWindow);

        if (speechClass === undefined) {
            return;
        }

        const recognition = new speechClass();

        recognition.lang = speechLanguage(optionsRef.current.language);
        // One phrase per press. A pause ends the session, so the owner presses again for more.
        recognition.continuous = false;
        recognition.interimResults = true;
        // A recognizer that was stopped or replaced is no longer this session, so its late events are ignored.
        recognition.onresult = (event) => {
            if (recognitionRef.current !== recognition) {
                return;
            }

            const transcript = transcriptOf(event);

            optionsRef.current.onTranscript(transcript);
        };
        recognition.onerror = (event) => {
            const message = describeSpeechError(event.error);

            if (recognitionRef.current === recognition && message !== undefined) {
                setErrorText(message);
            }
        };
        recognition.onend = () => {
            if (recognitionRef.current !== recognition) {
                return;
            }

            recognitionRef.current = undefined;
            setIsListening(false);
        };

        recognitionRef.current = recognition;
        setErrorText(undefined);
        optionsRef.current.onStart();
        setIsListening(true);

        try {
            recognition.start();
        } catch {
            recognitionRef.current = undefined;
            setIsListening(false);
            setErrorText(START_FAILED_STATUS);
        }
    }

    function toggle(): void {
        if (recognitionRef.current !== undefined) {
            recognitionRef.current.stop();

            return;
        }

        start();
    }

    // Stable, so an effect that depends on it does not stop listening on every render.
    const stopListening = useCallback((): void => {
        const recognition = recognitionRef.current;

        if (recognition === undefined) {
            return;
        }

        recognitionRef.current = undefined;
        recognition.abort();
        setIsListening(false);
    }, []);

    const statusText = errorText ?? (isListening ? LISTENING_STATUS : undefined);

    return { isSupported, isListening, statusText, toggle, stopListening };
}

export { findSpeechRecognition, describeSpeechError, joinVoiceText, speechLanguage, transcriptOf, useVoiceInput };
export type { SpeechAlternative, SpeechErrorEvent, SpeechRecognitionConstructor, SpeechRecognitionLike, SpeechResultEvent, SpeechWindow, VoiceInput, VoiceInputOptions };
