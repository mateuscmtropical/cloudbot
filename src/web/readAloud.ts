import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { ChatMessage } from '../shared/chatTypes.ts';
import { renderMarkdown } from './markdown.ts';

interface ReadableMessage {
    id: string;
    text: string;
}

// Some browsers stop a long utterance after about 15 seconds, so a reply is read in short pieces.
const MAX_PIECE_LENGTH = 200;
const AUTO_READ_KEY = 'cloudbot.autoRead';

const listeners = new Set<() => void>();
// The browser may drop an utterance it has no reference to, and then its end event never fires.
const heldUtterances: SpeechSynthesisUtterance[] = [];
let speakingId: string | undefined;

function canReadAloud(): boolean {
    return 'speechSynthesis' in globalThis;
}

function setSpeakingId(nextId: string | undefined): void {
    speakingId = nextId;
    listeners.forEach((listener) => {
        listener();
    });
}

function subscribeToSpeaking(listener: () => void): () => void {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
}

function readSpeakingId(): string | undefined {
    return speakingId;
}

function useSpeakingId(): string | undefined {
    return useSyncExternalStore(subscribeToSpeaking, readSpeakingId);
}

// The words a person would say. Markdown marks are gone, and a code block is left out because nobody wants it spelled.
function speakableText(markdown: string): string {
    const parser = new DOMParser();
    const html = renderMarkdown(markdown);
    const page = parser.parseFromString(html, 'text/html');
    const codeBlocks = page.querySelectorAll('pre');

    codeBlocks.forEach((block) => {
        block.remove();
    });

    const blockElements = page.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, td');

    blockElements.forEach((element) => {
        element.append('\n');
    });

    return page.body.textContent.trim();
}

// Cuts at the end of a sentence or line. A sentence longer than the limit is cut at a space.
function splitForSpeech(text: string): string[] {
    const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [];
    const pieces = sentences.flatMap(sentence => sentence.match(new RegExp(`.{1,${String(MAX_PIECE_LENGTH)}}(?:\\s|$)|\\S+`, 'g')) ?? []);
    const joined = pieces.reduce<string[]>((result, piece) => {
        const last = result.at(-1);

        if (last !== undefined && last.length + piece.length <= MAX_PIECE_LENGTH) {
            return [...result.slice(0, -1), last + piece];
        }

        return [...result, piece];
    }, []);
    const trimmed = joined.map(piece => piece.trim());

    return trimmed.filter(piece => piece !== '');
}

function stopReading(): void {
    if (!canReadAloud()) {
        return;
    }

    heldUtterances.length = 0;
    window.speechSynthesis.cancel();
    setSpeakingId(undefined);
}

function readAloud(id: string, markdown: string): void {
    stopReading();

    const plainText = speakableText(markdown);
    const pieces = splitForSpeech(plainText);

    if (!canReadAloud() || pieces.length === 0) {
        return;
    }

    const finish = (): void => {
        if (speakingId === id) {
            heldUtterances.length = 0;
            setSpeakingId(undefined);
        }
    };
    const utterances = pieces.map((piece) => {
        const utterance = new SpeechSynthesisUtterance(piece);

        utterance.lang = navigator.language;
        utterance.onerror = finish;

        return utterance;
    });
    const lastUtterance = utterances.at(-1);

    if (lastUtterance !== undefined) {
        lastUtterance.onend = finish;
    }

    heldUtterances.push(...utterances);
    setSpeakingId(id);
    utterances.forEach((utterance) => {
        window.speechSynthesis.speak(utterance);
    });
}

function readAutoReadChoice(): boolean {
    try {
        return window.localStorage.getItem(AUTO_READ_KEY) === 'on';
    } catch {
        return false;
    }
}

function saveAutoReadChoice(isOn: boolean): void {
    try {
        window.localStorage.setItem(AUTO_READ_KEY, isOn ? 'on' : 'off');
    } catch {
        // A browser that blocks storage keeps the choice until the page closes.
    }
}

// The newest message, when it is a reply from the bot and the turn has ended. During a turn the bot may still send more.
function finishedReply(messages: ChatMessage[], isRunning: boolean): ReadableMessage | undefined {
    const newest = messages.at(-1);

    if (isRunning || newest?.role !== 'assistant' || newest.body.kind !== 'text') {
        return undefined;
    }

    return { id: newest.id, text: newest.body.text };
}

interface AutoRead {
    isAutoRead: boolean;
    setAutoRead: (isOn: boolean) => void;
}

// Reads each new reply when the option is on. A reply that was there when the chat opened stays silent.
function useAutoRead(botId: string | undefined, messages: ChatMessage[], isRunning: boolean): AutoRead {
    const [isAutoRead, setIsAutoRead] = useState(readAutoReadChoice);
    const reply = finishedReply(messages, isRunning);
    const replyId = reply?.id;
    const replyText = reply?.text;
    const seenRef = useRef<{ botId: string | undefined; newestId: string | undefined } | undefined>(undefined);
    const newestMessage = messages.at(-1);
    // Right after a switch the list still holds the other bot's messages, and those are not news.
    const newestId = newestMessage?.botId === botId ? newestMessage?.id : undefined;

    useEffect(() => {
        return stopReading;
    }, [botId]);

    useEffect(() => {
        const seen = seenRef.current;

        // The first messages of a chat load after it opens, and those are old replies.
        if (seen === undefined || seen.botId !== botId || seen.newestId === undefined) {
            seenRef.current = { botId, newestId };

            return;
        }

        if (replyId === undefined || replyText === undefined) {
            return;
        }

        if (seen.newestId === replyId) {
            return;
        }

        seenRef.current = { botId, newestId: replyId };

        if (isAutoRead) {
            readAloud(replyId, replyText);
        }
    }, [botId, isAutoRead, newestId, replyId, replyText]);

    return {
        isAutoRead,
        setAutoRead: (isOn) => {
            setIsAutoRead(isOn);
            saveAutoReadChoice(isOn);
        },
    };
}

export { canReadAloud, finishedReply, readAloud, speakableText, splitForSpeech, stopReading, useAutoRead, useSpeakingId };
export type { AutoRead, ReadableMessage };
