// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import type { DraftAttachment } from './Composer.tsx';
import { Composer } from './Composer.tsx';

interface RenderOptions {
    isRunning?: boolean;
    isUploading?: boolean;
    attachments?: DraftAttachment[];
    onSend?: (text: string) => void;
    onRemoveAttachment?: (attachmentId: string) => void;
    sentHistory?: string[];
}

function renderComposer(options: RenderOptions = {}): HTMLTextAreaElement {
    render(
        <Composer
            botName="CloudBot"
            isRunning={options.isRunning ?? false}
            isUploading={options.isUploading ?? false}
            attachments={options.attachments ?? []}
            onSend={options.onSend ?? vi.fn()}
            onStop={vi.fn()}
            onAttach={vi.fn()}
            onRemoveAttachment={options.onRemoveAttachment ?? vi.fn()}
            sentHistory={options.sentHistory}
        />,
    );

    return screen.getByPlaceholderText<HTMLTextAreaElement>('Ask CloudBot...');
}

describe('Composer', () => {
    afterEach(() => {
        cleanup();
    });

    it('sends the draft when Enter is pressed', () => {
        const onSend = vi.fn();
        const textarea = renderComposer({ onSend });

        fireEvent.change(textarea, { target: { value: 'hello' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });

        expect(onSend)
            .toHaveBeenCalledWith('hello');
        expect(textarea.value)
            .toBe('');
    });

    it('keeps the draft and sends nothing when Shift+Enter is pressed', () => {
        const onSend = vi.fn();
        const textarea = renderComposer({ onSend });

        fireEvent.change(textarea, { target: { value: 'first line' } });
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

        expect(onSend)
            .not.toHaveBeenCalled();
        expect(textarea.value)
            .toBe('first line');
    });

    it('sends nothing on Enter with a touch keyboard, so only the button sends', () => {
        const touchQuery = { matches: true } as MediaQueryList;

        vi.spyOn(window, 'matchMedia')
            .mockReturnValue(touchQuery);

        const onSend = vi.fn();
        const textarea = renderComposer({ onSend });

        fireEvent.change(textarea, { target: { value: 'first line' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });

        expect(onSend)
            .not.toHaveBeenCalled();
        expect(textarea.getAttribute('enterkeyhint'))
            .toBe('enter');
        vi.restoreAllMocks();
    });

    it('shows a stop button instead of send while a turn runs', () => {
        renderComposer({ isRunning: true });

        expect(screen.getByRole('button', { name: 'Stop' }))
            .toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Send' }))
            .toBeNull();
    });

    it('sends a draft typed while a turn runs, so it is queued', () => {
        const onSend = vi.fn();
        const textarea = renderComposer({ onSend, isRunning: true });

        fireEvent.change(textarea, { target: { value: 'next question' } });

        expect(screen.getByRole('button', { name: 'Send' }))
            .toBeTruthy();

        fireEvent.keyDown(textarea, { key: 'Enter' });

        expect(onSend)
            .toHaveBeenCalledWith('next question');
    });

    it('lists the attached files as chips and marks the ones still uploading', () => {
        renderComposer({
            attachments: [
                { id: '1', name: 'notes.txt', status: 'uploading' },
                { id: '2', name: 'photo.png', status: 'ready' },
            ],
        });

        expect(screen.getByText('notes.txt (uploading)'))
            .toBeTruthy();
        expect(screen.getByText('photo.png'))
            .toBeTruthy();
    });

    it('does not send while a file is still uploading', () => {
        const onSend = vi.fn();
        const textarea = renderComposer({ onSend, isUploading: true });

        fireEvent.change(textarea, { target: { value: 'read this' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });

        expect(onSend)
            .not.toHaveBeenCalled();
        const sendButton = screen.getByRole('button', { name: 'Send' });

        expect(sendButton.hasAttribute('disabled'))
            .toBe(true);
    });

    it('disables the attach button while a turn runs', () => {
        renderComposer({ isRunning: true });

        const attachButton = screen.getByRole('button', { name: 'Attach files' });

        expect(attachButton.hasAttribute('disabled'))
            .toBe(true);
    });

    it('uses the file picker with the correct photo and video filters', () => {
        const view = render(
            <Composer
                botName="CloudBot"
                isRunning={false}
                isUploading={false}
                attachments={[]}
                onSend={vi.fn()}
                onStop={vi.fn()}
                onAttach={vi.fn()}
                onRemoveAttachment={vi.fn()}
            />,
        );
        const fileInput = view.container.querySelector<HTMLInputElement>('.composer-file-input');

        if (fileInput === null) {
            throw new Error('The file picker is missing');
        }

        fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
        fireEvent.click(screen.getByRole('button', { name: 'Take photo' }));

        expect(fileInput.getAttribute('accept'))
            .toBe('image/*');
        expect(fileInput.getAttribute('capture'))
            .toBe('environment');

        fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
        fireEvent.click(screen.getByRole('button', { name: 'Photo or video' }));

        expect(fileInput.getAttribute('accept'))
            .toBe('image/*,video/*');
        expect(fileInput.hasAttribute('capture'))
            .toBe(false);

        fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
        fireEvent.click(screen.getByRole('button', { name: 'Choose file' }));

        expect(fileInput.hasAttribute('accept'))
            .toBe(false);
        expect(fileInput.hasAttribute('capture'))
            .toBe(false);
    });

    it('removes a ready file through its remove button', () => {
        const onRemoveAttachment = vi.fn();

        renderComposer({
            attachments: [{ id: 'server-1', name: 'notes.txt', status: 'ready' }],
            onRemoveAttachment,
        });
        fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));

        expect(onRemoveAttachment)
            .toHaveBeenCalledWith('server-1');
    });

    it('disables the waveform voice button when the browser has no speech recognition', () => {
        renderComposer();

        expect(screen.getByRole('button', { name: 'Voice input' })
            .hasAttribute('disabled'))
            .toBe(true);
    });

    it('starts voice input from the waveform button when the draft is empty', () => {
        class HearingRecognition {
            lang = '';
            continuous = false;
            interimResults = false;
            onresult: ((event: { readonly results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
            onerror: ((event: { readonly error: string }) => void) | null = null;
            onend: (() => void) | null = null;
            start = vi.fn();

            stop(): void {
                this.onend?.();
            }

            abort(): void {
                this.onend?.();
            }
        }

        const instances: HearingRecognition[] = [];

        vi.stubGlobal('SpeechRecognition', class extends HearingRecognition {
            constructor() {
                super();
                instances.push(this);
            }
        });

        try {
            renderComposer();
            const waveformButton = screen.getByRole('button', { name: 'Voice input' });

            fireEvent.click(waveformButton);

            expect(waveformButton.getAttribute('aria-pressed'))
                .toBe('true');
            expect(instances[0]?.start)
                .toHaveBeenCalledTimes(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('puts the spoken words after the typed text, and shows the press state of the mic', () => {
        class HearingRecognition {
            lang = '';
            continuous = false;
            interimResults = false;
            onresult: ((event: { readonly results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
            onerror: ((event: { readonly error: string }) => void) | null = null;
            onend: (() => void) | null = null;

            start(): void {
                // The fake hears words only when the test says so.
            }

            stop(): void {
                this.onend?.();
            }

            abort(): void {
                this.onend?.();
            }

            hear(transcript: string): void {
                this.onresult?.({ results: [[{ transcript }]] });
            }
        }

        const instances: HearingRecognition[] = [];

        vi.stubGlobal('SpeechRecognition', class extends HearingRecognition {
            constructor() {
                super();
                instances.push(this);
            }
        });

        try {
            const textarea = renderComposer();

            fireEvent.change(textarea, { target: { value: 'Hello' } });
            fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));

            expect(screen.getByRole('button', { name: 'Voice input' })
                .getAttribute('aria-pressed'))
                .toBe('true');

            const recognition = instances[0];

            act(() => {
                recognition?.hear('book a table');
            });

            expect(textarea.value)
                .toBe('Hello book a table');

            fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));

            expect(screen.getByRole('button', { name: 'Voice input' })
                .getAttribute('aria-pressed'))
                .toBe('false');
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('Composer message history', () => {
    afterEach(() => {
        cleanup();
    });

    it('brings back the sent messages with arrow up, newest first', () => {
        const textarea = renderComposer({ sentHistory: ['first', 'second', 'third'] });

        fireEvent.keyDown(textarea, { key: 'ArrowUp' });

        expect(textarea.value)
            .toBe('third');

        fireEvent.keyDown(textarea, { key: 'ArrowUp' });
        fireEvent.keyDown(textarea, { key: 'ArrowUp' });
        fireEvent.keyDown(textarea, { key: 'ArrowUp' });

        expect(textarea.value)
            .toBe('first');
    });

    it('goes forward with arrow down and returns the text that was being typed', () => {
        const textarea = renderComposer({ sentHistory: ['first', 'second'] });

        fireEvent.change(textarea, { target: { value: 'half written' } });
        fireEvent.keyDown(textarea, { key: 'ArrowUp' });
        fireEvent.keyDown(textarea, { key: 'ArrowUp' });

        expect(textarea.value)
            .toBe('first');

        fireEvent.keyDown(textarea, { key: 'ArrowDown' });

        expect(textarea.value)
            .toBe('second');

        fireEvent.keyDown(textarea, { key: 'ArrowDown' });

        expect(textarea.value)
            .toBe('half written');
    });

    it('does nothing without history and leaves arrow down alone outside the history', () => {
        const textarea = renderComposer();

        fireEvent.change(textarea, { target: { value: 'typed' } });
        fireEvent.keyDown(textarea, { key: 'ArrowUp' });
        fireEvent.keyDown(textarea, { key: 'ArrowDown' });

        expect(textarea.value)
            .toBe('typed');
    });

    it('stops the walk when the person types, and sends what is in the box', () => {
        const onSend = vi.fn();
        const textarea = renderComposer({ onSend, sentHistory: ['one', 'two'] });

        fireEvent.keyDown(textarea, { key: 'ArrowUp' });
        fireEvent.change(textarea, { target: { value: 'two edited' } });
        fireEvent.keyDown(textarea, { key: 'ArrowDown' });

        expect(textarea.value)
            .toBe('two edited');

        fireEvent.keyDown(textarea, { key: 'Enter' });

        expect(onSend)
            .toHaveBeenCalledWith('two edited');
    });

    it('keeps the arrows for the caret inside a message with several lines', () => {
        const textarea = renderComposer({ sentHistory: ['old'] });

        fireEvent.change(textarea, { target: { value: 'line one\nline two' } });
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        fireEvent.keyDown(textarea, { key: 'ArrowUp' });

        expect(textarea.value)
            .toBe('line one\nline two');

        textarea.setSelectionRange(0, 0);
        fireEvent.keyDown(textarea, { key: 'ArrowUp' });

        expect(textarea.value)
            .toBe('old');
    });

    it('ignores the arrows with a modifier key', () => {
        const textarea = renderComposer({ sentHistory: ['old'] });

        fireEvent.keyDown(textarea, { key: 'ArrowUp', shiftKey: true });

        expect(textarea.value)
            .toBe('');
    });
});

interface RecordingRecognition {
    aborted: boolean;
    onresult: ((event: { readonly results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onend: (() => void) | null;
    hear: (transcript: string) => void;
}

// A fake recognizer that records whether it was aborted, and hears words only when the test says so.
function stubRecognition(): RecordingRecognition[] {
    const instances: RecordingRecognition[] = [];

    class FakeRecognition {
        lang = '';
        continuous = false;
        interimResults = false;
        aborted = false;
        onresult: RecordingRecognition['onresult'] = null;
        onerror: ((event: { readonly error: string }) => void) | null = null;
        onend: (() => void) | null = null;

        constructor() {
            instances.push(this);
        }

        start(): void {
            // Nothing is heard until the test calls hear.
        }

        stop(): void {
            this.onend?.();
        }

        abort(): void {
            this.aborted = true;
            this.onend?.();
        }

        hear(transcript: string): void {
            this.onresult?.({ results: [[{ transcript }]] });
        }
    }

    vi.stubGlobal('SpeechRecognition', FakeRecognition);

    return instances;
}

function composerElement(botName: string, onSend: (text: string) => void, isRunning = false, onStop = vi.fn()): ReactElement {
    return (
        <Composer
            botName={botName}
            isRunning={isRunning}
            isUploading={false}
            attachments={[]}
            onSend={onSend}
            onStop={onStop}
            onAttach={vi.fn()}
            onRemoveAttachment={vi.fn()}
        />
    );
}

describe('Composer voice input while listening', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('sending ends listening, and words heard afterwards never reach the draft', () => {
        const instances = stubRecognition();
        const onSend = vi.fn();

        render(composerElement('CloudBot', onSend));

        const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Ask CloudBot...');

        fireEvent.change(textarea, { target: { value: 'Hello' } });
        fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));
        act(() => {
            instances[0]?.hear('book a table');
        });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        act(() => {
            instances[0]?.hear('late words');
        });

        expect(onSend)
            .toHaveBeenCalledWith('Hello book a table');
        expect(instances[0]?.aborted)
            .toBe(true);
        expect(textarea.value)
            .toBe('');
        expect(screen.getByRole('button', { name: 'Voice input' })
            .getAttribute('aria-pressed'))
            .toBe('false');
    });

    it('typing while listening stops listening first, and later words do not replace the typed text', () => {
        const instances = stubRecognition();

        render(composerElement('CloudBot', vi.fn()));

        const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Ask CloudBot...');

        fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));
        fireEvent.change(textarea, { target: { value: 'Typed' } });

        expect(instances[0]?.aborted)
            .toBe(true);
        expect(screen.getByRole('button', { name: 'Voice input' })
            .getAttribute('aria-pressed'))
            .toBe('false');

        act(() => {
            instances[0]?.hear('spoken');
        });

        expect(textarea.value)
            .toBe('Typed');
    });

    it('stops voice input before stopping a turn that started while listening', () => {
        const instances = stubRecognition();
        const onStop = vi.fn();
        const view = render(composerElement('CloudBot', vi.fn(), false, onStop));

        fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));
        view.rerender(composerElement('CloudBot', vi.fn(), true, onStop));
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        act(() => {
            instances[0]?.hear('late words');
        });

        expect(onStop)
            .toHaveBeenCalledTimes(1);
        expect(instances[0]?.aborted)
            .toBe(true);
        expect(screen.getByPlaceholderText<HTMLTextAreaElement>('Ask CloudBot...').value)
            .toBe('');
    });

    it('an empty transcript leaves the draft as it is', () => {
        const instances = stubRecognition();

        render(composerElement('CloudBot', vi.fn()));

        const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Ask CloudBot...');

        fireEvent.change(textarea, { target: { value: 'Hi' } });
        fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));
        act(() => {
            instances[0]?.hear('   ');
        });

        expect(textarea.value)
            .toBe('Hi');
    });

    it('changing the bot stops listening', () => {
        const instances = stubRecognition();
        const view = render(composerElement('Ana', vi.fn()));

        fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));
        view.rerender(composerElement('Ben', vi.fn()));

        expect(instances[0]?.aborted)
            .toBe(true);
    });

    it('keeps the status line in the page, and changes only its text', () => {
        stubRecognition();

        render(composerElement('CloudBot', vi.fn()));

        const status = screen.getByRole('status');

        expect(status.textContent)
            .toBe('');

        fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));

        expect(screen.getByRole('status'))
            .toBe(status);
        expect(status.textContent)
            .toBe('Listening. Speak now.');
    });
});
