import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CdpConnection } from '../desktop/CdpConnection.ts';
import { MeetingRecorder, formatOffset, isMeetingUrl, transcriptFileName } from './MeetingRecorder.ts';
import type { MeetingRecorderOptions } from './MeetingRecorder.ts';

interface FakePage {
    page: CdpConnection;
    close: ReturnType<typeof vi.fn>;
    takes: string[];
}

interface Harness {
    recorder: MeetingRecorder;
    fake: FakePage;
    saved: Map<string, string>;
    ended: ReturnType<typeof vi.fn>;
}

const SEGMENT_MS = 1000;
const AUDIO = Buffer.from('audio')
    .toString('base64');

function fakePage(url: string, liveTracks: () => number): FakePage {
    const close = vi.fn();
    const takes: string[] = [];
    const call = vi.fn((method: string, params: Record<string, unknown> = {}) => {
        const expression = typeof params.expression === 'string' ? params.expression : '';

        if (method === 'Page.getFrameTree') {
            return Promise.resolve({ frameTree: { frame: { id: 'frame' } } });
        }

        if (method === 'Page.createIsolatedWorld') {
            return Promise.resolve({ executionContextId: 7 });
        }

        if (expression === 'location.href') {
            return Promise.resolve({ result: { value: url } });
        }

        if (expression.includes('.take(')) {
            takes.push(expression);

            return Promise.resolve({ result: { value: { audio: AUDIO, liveTracks: liveTracks() } } });
        }

        return Promise.resolve({ result: { value: 'running' } });
    });
    const page = { call, close } as unknown as CdpConnection;

    return { page, close, takes };
}

function setup(url: string, liveTracks: () => number = () => 1): Harness {
    const fake = fakePage(url, liveTracks);
    const saved = new Map<string, string>();
    const ended = vi.fn();
    const transcribe = vi.fn(() => Promise.resolve('hello there'));
    const options: MeetingRecorderOptions = {
        browser: { connectPage: () => Promise.resolve(fake.page) },
        transcribe,
        saveTranscript: (botId, fileName, text) => {
            const path = `/uploads/${botId}/${fileName}`;

            saved.set(path, text);

            return Promise.resolve(path);
        },
        onEnded: ended,
        segmentMs: SEGMENT_MS,
        now: () => Date.now(),
    };
    const recorder = new MeetingRecorder(options);

    return { recorder, fake, saved, ended };
}

describe('MeetingRecorder', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-05T14:30:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('refuses a page that is not a Google Meet call and lets the page go', async () => {
        const { recorder, fake } = setup('https://example.com/');

        await expect(recorder.start('bot-1', 'pt')).rejects.toThrow('Open the Google Meet call');
        expect(fake.close)
            .toHaveBeenCalled();
    });

    it('transcribes each part and saves the transcript when stopped', async () => {
        const { recorder, fake, saved } = setup('https://meet.google.com/abc-defg-hij');

        await recorder.start('bot-1', 'pt');
        await expect(recorder.start('bot-1', 'pt')).rejects.toThrow('already being recorded');
        await vi.advanceTimersByTimeAsync(SEGMENT_MS);

        expect(recorder.status('bot-1'))
            .toContain('[00:00] hello there');
        expect(recorder.status('bot-2'))
            .toBeUndefined();

        const result = await recorder.stop('bot-1');

        expect(result)
            .toEqual({ transcriptPath: '/uploads/bot-1/meeting-2026-11-05-1430.md', lineCount: 2, failedSegments: 0 });
        expect(saved.get('/uploads/bot-1/meeting-2026-11-05-1430.md'))
            .toContain('[00:01] hello there');
        expect(fake.takes.at(-1))
            .toContain('take(false)');
        expect(fake.close)
            .toHaveBeenCalled();
        expect(recorder.status('bot-1'))
            .toBeUndefined();
    });

    it('ends by itself when no audio plays for two parts and tells the bot', async () => {
        const { recorder, ended } = setup('https://meet.google.com/abc-defg-hij', () => 0);

        await recorder.start('bot-1', undefined);
        await vi.advanceTimersByTimeAsync(SEGMENT_MS * 2);

        expect(ended)
            .toHaveBeenCalledWith('bot-1', '/uploads/bot-1/meeting-2026-11-05-1430.md');
        expect(recorder.status('bot-1'))
            .toBeUndefined();
    });
});

describe('meeting helpers', () => {
    it('accepts only https Google Meet pages', () => {
        expect(isMeetingUrl('https://meet.google.com/abc-defg-hij'))
            .toBe(true);
        expect(isMeetingUrl('http://meet.google.com/abc'))
            .toBe(false);
        expect(isMeetingUrl('https://meet.google.com.evil.example/abc'))
            .toBe(false);
    });

    it('formats offsets and file names', () => {
        expect(formatOffset(65_000))
            .toBe('01:05');
        expect(formatOffset(3_725_000))
            .toBe('1:02:05');
        expect(transcriptFileName(Date.parse('2026-11-05T09:07:00Z')))
            .toBe('meeting-2026-11-05-0907.md');
    });
});
