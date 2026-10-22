// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpeechRecognitionConstructor, SpeechResultEvent } from './voiceInput.ts';
import { describeSpeechError, findSpeechRecognition, joinVoiceText, speechLanguage, transcriptOf, useVoiceInput } from './voiceInput.ts';

// A stand-in for the browser recognizer. Tests make it hear words, fail, or finish on purpose.
class FakeSpeechRecognition {
    static instances: FakeSpeechRecognition[] = [];
    lang = '';
    continuous = false;
    interimResults = false;
    onresult: ((event: SpeechResultEvent) => void) | null = null;
    onerror: ((event: { readonly error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    isStarted = false;
    stopCount = 0;
    isAborted = false;

    constructor() {
        FakeSpeechRecognition.instances.push(this);
    }

    start(): void {
        this.isStarted = true;
    }

    stop(): void {
        this.stopCount += 1;
    }

    abort(): void {
        this.isAborted = true;
    }

    hear(...transcripts: string[]): void {
        const results = transcripts.map(transcript => [{ transcript }]);

        this.onresult?.({ results });
    }

    fail(error: string): void {
        this.onerror?.({ error });
    }

    finish(): void {
        this.onend?.();
    }
}

// The fake must satisfy the constructor shape the hook expects.
const fakeSpeech: SpeechRecognitionConstructor = FakeSpeechRecognition;

function lastRecognition(): FakeSpeechRecognition {
    const recognition = FakeSpeechRecognition.instances.at(-1);

    if (recognition === undefined) {
        throw new Error('No recognizer was created.');
    }

    return recognition;
}

describe('findSpeechRecognition', () => {
    it('prefers the standard constructor and falls back to the webkit one', () => {
        const standard = fakeSpeech;
        const webkit = fakeSpeech;

        expect(findSpeechRecognition({ SpeechRecognition: standard, webkitSpeechRecognition: webkit }))
            .toBe(standard);
        expect(findSpeechRecognition({ webkitSpeechRecognition: webkit }))
            .toBe(webkit);
        expect(findSpeechRecognition({}))
            .toBeUndefined();
    });
});

describe('speechLanguage', () => {
    it('uses the browser language and falls back to English when it is missing', () => {
        expect(speechLanguage('pt-BR'))
            .toBe('pt-BR');
        expect(speechLanguage('  '))
            .toBe('en-US');
        expect(speechLanguage(undefined))
            .toBe('en-US');
    });
});

describe('transcriptOf', () => {
    it('joins the heard phrases with single spaces and skips empty ones', () => {
        const event: SpeechResultEvent = { results: [[{ transcript: ' Book a table ' }], [{ transcript: '' }], [{ transcript: 'for two' }]] };

        expect(transcriptOf(event))
            .toBe('Book a table for two');
    });
});

describe('joinVoiceText', () => {
    it('keeps the typed text and adds the spoken words after it', () => {
        expect(joinVoiceText('Hello   ', 'book a table'))
            .toBe('Hello book a table');
        expect(joinVoiceText('', 'book a table'))
            .toBe('book a table');
    });
});

describe('describeSpeechError', () => {
    it('explains the errors the owner can act on, and shows nothing for a stop by the owner', () => {
        expect(describeSpeechError('not-allowed'))
            .toBe('Microphone access was denied.');
        expect(describeSpeechError('no-speech'))
            .toBe('No speech was heard.');
        expect(describeSpeechError('audio-capture'))
            .toBe('No microphone was found.');
        expect(describeSpeechError('something-new'))
            .toBe('Voice input stopped.');
        expect(describeSpeechError('aborted'))
            .toBeUndefined();
    });
});

describe('useVoiceInput', () => {
    beforeEach(() => {
        FakeSpeechRecognition.instances = [];
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    function renderVoiceInput(onStart = vi.fn(), onTranscript = vi.fn()): { result: { current: ReturnType<typeof useVoiceInput> }; onStart: ReturnType<typeof vi.fn>; onTranscript: ReturnType<typeof vi.fn>; unmount: () => void } {
        const rendered = renderHook(() => useVoiceInput({ language: 'pt-BR', onStart, onTranscript }));

        return { result: rendered.result, onStart, onTranscript, unmount: rendered.unmount };
    }

    it('reports no support, and does nothing, when the browser has no speech recognition', () => {
        const { result, onStart } = renderVoiceInput();

        act(() => {
            result.current.toggle();
        });

        expect(result.current.isSupported)
            .toBe(false);
        expect(onStart)
            .not.toHaveBeenCalled();
        expect(result.current.isListening)
            .toBe(false);
    });

    it('starts listening in the browser language, for one phrase at a time, and reports the words heard', () => {
        vi.stubGlobal('SpeechRecognition', fakeSpeech);
        const { result, onStart, onTranscript } = renderVoiceInput();

        act(() => {
            result.current.toggle();
        });

        const recognition = lastRecognition();

        expect(result.current.isSupported)
            .toBe(true);
        expect(recognition.isStarted)
            .toBe(true);
        expect(recognition.lang)
            .toBe('pt-BR');
        expect(recognition.continuous)
            .toBe(false);
        expect(recognition.interimResults)
            .toBe(true);
        expect(onStart)
            .toHaveBeenCalledTimes(1);
        expect(result.current.isListening)
            .toBe(true);
        expect(result.current.statusText)
            .toBe('Listening. Speak now.');

        act(() => {
            recognition.hear('book a');
            recognition.hear('book a table');
        });

        expect(onTranscript)
            .toHaveBeenLastCalledWith('book a table');
    });

    it('calls the newest callback after a rerender, not the one from the first render', () => {
        vi.stubGlobal('SpeechRecognition', fakeSpeech);
        const firstTranscript = vi.fn();
        const newestTranscript = vi.fn();
        const rendered = renderHook(
            ({ onTranscript }: { onTranscript: (transcript: string) => void }) => useVoiceInput({ language: 'pt-BR', onStart: vi.fn(), onTranscript }),
            { initialProps: { onTranscript: firstTranscript } },
        );

        rendered.rerender({ onTranscript: newestTranscript });

        act(() => {
            rendered.result.current.toggle();
        });

        act(() => {
            lastRecognition()
                .hear('hello');
        });

        expect(firstTranscript)
            .not.toHaveBeenCalled();
        expect(newestTranscript)
            .toHaveBeenLastCalledWith('hello');
    });

    it('stops on a second press, and listening ends when the browser finishes', () => {
        vi.stubGlobal('SpeechRecognition', fakeSpeech);
        const { result } = renderVoiceInput();

        act(() => {
            result.current.toggle();
        });

        const recognition = lastRecognition();

        act(() => {
            result.current.toggle();
        });

        expect(recognition.stopCount)
            .toBe(1);
        expect(result.current.isListening)
            .toBe(true);

        act(() => {
            recognition.finish();
        });

        expect(result.current.isListening)
            .toBe(false);
        expect(result.current.statusText)
            .toBeUndefined();
    });

    it('shows a denied microphone for a few seconds, then clears it', () => {
        vi.useFakeTimers();
        vi.stubGlobal('SpeechRecognition', fakeSpeech);
        const { result } = renderVoiceInput();

        act(() => {
            result.current.toggle();
        });

        act(() => {
            lastRecognition()
                .fail('not-allowed');
            lastRecognition()
                .finish();
        });

        expect(result.current.statusText)
            .toBe('Microphone access was denied.');

        act(() => {
            vi.advanceTimersByTime(4000);
        });

        expect(result.current.statusText)
            .toBeUndefined();
    });

    it('shows nothing when the owner stopped the recognizer', () => {
        vi.stubGlobal('SpeechRecognition', fakeSpeech);
        const { result } = renderVoiceInput();

        act(() => {
            result.current.toggle();
        });

        act(() => {
            lastRecognition()
                .fail('aborted');
        });

        expect(result.current.statusText)
            .toBe('Listening. Speak now.');
    });

    it('reports a start that the browser refuses, and does not stay in listening', () => {
        class RefusingRecognition extends FakeSpeechRecognition {
            override start(): void {
                throw new Error('already started');
            }
        }

        vi.stubGlobal('SpeechRecognition', RefusingRecognition);
        const { result } = renderVoiceInput();

        act(() => {
            result.current.toggle();
        });

        expect(result.current.isListening)
            .toBe(false);
        expect(result.current.statusText)
            .toBe('Voice input could not start.');
    });

    it('aborts the recognizer when the composer goes away', () => {
        vi.stubGlobal('SpeechRecognition', fakeSpeech);
        const { result, unmount } = renderVoiceInput();

        act(() => {
            result.current.toggle();
        });

        const recognition = lastRecognition();

        unmount();

        expect(recognition.isAborted)
            .toBe(true);
    });
});
