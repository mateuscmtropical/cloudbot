// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeToEvents } from './apiClient.ts';

// The browser's number for a closed stream.
const CLOSED_STATE = 2;

class FakeEventSource extends EventTarget {
    static readonly opened: FakeEventSource[] = [];
    readyState = 0;
    isClosed = false;
    readonly url: string;

    constructor(url: string) {
        super();
        this.url = url;
        FakeEventSource.opened.push(this);
    }

    close(): void {
        this.isClosed = true;
        this.readyState = CLOSED_STATE;
    }
}

// The code reads EventSource.CLOSED, so the fake carries it under the browser's name.
Object.defineProperty(FakeEventSource, 'CLOSED', { value: CLOSED_STATE });

function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
}

describe('subscribeToEvents', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeEventSource.opened.length = 0;
        vi.stubGlobal('EventSource', FakeEventSource);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('opens the stream again when the page is shown, and reloads through onOpen', () => {
        const onOpen = vi.fn();
        const unsubscribe = subscribeToEvents('bot-1', vi.fn(), onOpen);

        setVisibility('hidden');
        setVisibility('visible');

        const [first, second] = FakeEventSource.opened;

        expect(FakeEventSource.opened)
            .toHaveLength(2);
        expect(first?.isClosed)
            .toBe(true);

        second?.dispatchEvent(new Event('open'));

        expect(onOpen)
            .toHaveBeenCalledTimes(1);
        unsubscribe();
        expect(second?.isClosed)
            .toBe(true);
    });

    it('tries again after the browser closed the stream on an error', () => {
        const unsubscribe = subscribeToEvents('bot-1', vi.fn(), vi.fn());
        const [first] = FakeEventSource.opened;

        if (first !== undefined) {
            first.readyState = CLOSED_STATE;
            first.dispatchEvent(new Event('error'));
        }

        vi.advanceTimersByTime(3000);

        expect(FakeEventSource.opened)
            .toHaveLength(2);
        unsubscribe();
    });
});
