import type { CdpConnection } from '../desktop/CdpConnection.ts';
import { createIsolatedContext, readEvaluatedValue } from '../desktop/BrowserControl.ts';
import type { BrowserControl } from '../desktop/BrowserControl.ts';
import type { TranscribeAudio } from '../voice/transcribeAudio.ts';
import { evaluateInPage } from '../desktop/evaluateInPage.ts';
import { pageUrl } from '../desktop/page/pageLocation.ts';
import { pageStartMeetingRecording, pageTakeMeetingRecording } from '../desktop/page/pageMeetingRecording.ts';

interface MeetingRecorderOptions {
    browser: Pick<BrowserControl, 'connectPage'>;
    // Its own transcriber, so a voice message in the chat does not wait for a meeting.
    transcribe: TranscribeAudio;
    // Saves the transcript where the bot can read it, and returns its path.
    saveTranscript: (botId: string, fileName: string, text: string) => Promise<string>;
    // The meeting ended without the bot stopping it, such as when the host ended it.
    onEnded: (botId: string, transcriptPath: string) => void;
    segmentMs?: number;
    maxMeetingMs?: number;
    now?: () => number;
}

interface MeetingRecording {
    botId: string;
    page: CdpConnection;
    contextId: number;
    language: string | undefined;
    startedAt: number;
    segmentStartedAt: number;
    lines: string[];
    failedSegments: number;
    quietSegments: number;
    transcribing: Promise<void>;
    timer: NodeJS.Timeout | undefined;
    // Set while a part is taken from the page.
    taking: Promise<void> | undefined;
}

// What the page script returns: the recorded audio as base64 webm, and how many audio tracks still play.
interface PageSegment {
    audio: string;
    liveTracks: number;
}

interface TakenSegment extends PageSegment {
    offsetMs: number;
}

interface MeetingResult {
    transcriptPath: string;
    lineCount: number;
    failedSegments: number;
}

class MeetingRecorderError extends Error {}

const MEETING_HOST = 'meet.google.com';
// whisper takes at most 360 seconds of one recording, see transcribeAudio.ts.
const SEGMENT_MS = 5 * 60 * 1000;
const MAX_MEETING_MS = 4 * 60 * 60 * 1000;
// A meeting with no live audio for two segments in a row has ended, such as after the bot left.
const QUIET_SEGMENTS_TO_END = 2;
const EVALUATE_TIMEOUT_MS = 60_000;

function readTakenSegment(value: unknown): PageSegment {
    if (typeof value !== 'object' || value === null) {
        return { audio: '', liveTracks: 0 };
    }

    const audio: unknown = Reflect.get(value, 'audio');
    const liveTracks: unknown = Reflect.get(value, 'liveTracks');

    return { audio: typeof audio === 'string' ? audio : '', liveTracks: typeof liveTracks === 'number' ? liveTracks : 0 };
}

function formatOffset(offsetMs: number): string {
    const totalSeconds = Math.floor(offsetMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const clock = [minutes, seconds].map(part => String(part)
        .padStart(2, '0'));

    return hours > 0 ? `${String(hours)}:${clock.join(':')}` : clock.join(':');
}

function transcriptFileName(startedAt: number): string {
    const stamp = new Date(startedAt)
        .toISOString()
        .slice(0, 16)
        .replace('T', '-')
        .replace(':', '');

    return `meeting-${stamp}.md`;
}

function isMeetingUrl(url: string): boolean {
    try {
        const parsed = new URL(url);

        return parsed.protocol === 'https:' && parsed.hostname === MEETING_HOST;
    } catch {
        return false;
    }
}

// Records the meeting on the bot's screen in segments and turns each one into text while the meeting goes on.
// ponytail: one recording per instance, since there is one browser. A second meeting waits until the first is stopped.
class MeetingRecorder {
    private readonly options: MeetingRecorderOptions;
    private readonly segmentMs: number;
    private readonly maxMeetingMs: number;
    private readonly now: () => number;
    private recording: MeetingRecording | undefined;

    constructor(options: MeetingRecorderOptions) {
        this.options = options;
        this.segmentMs = options.segmentMs ?? SEGMENT_MS;
        this.maxMeetingMs = options.maxMeetingMs ?? MAX_MEETING_MS;
        this.now = options.now ?? (() => Date.now());
    }

    async start(botId: string, language: string | undefined): Promise<void> {
        if (this.recording !== undefined) {
            throw new MeetingRecorderError('A meeting is already being recorded. Stop it first.');
        }

        const page = await this.options.browser.connectPage();

        try {
            const urlResult = await evaluateInPage(page, pageUrl, [], { returnByValue: true });
            const url = readEvaluatedValue(urlResult);

            if (typeof url !== 'string' || !isMeetingUrl(url)) {
                throw new MeetingRecorderError('Open the Google Meet call on the screen first, and join it.');
            }

            const contextId = await createIsolatedContext(page);

            await evaluateInPage(page, pageStartMeetingRecording, [], { contextId, awaitPromise: true, returnByValue: true, userGesture: true });

            const startedAt = this.now();
            const recording: MeetingRecording = {
                botId, page, contextId, language, startedAt, segmentStartedAt: startedAt, lines: [], failedSegments: 0, quietSegments: 0,
                transcribing: Promise.resolve(), timer: undefined, taking: undefined,
            };

            recording.timer = setInterval(() => {
                void this.takeSegment(recording);
            }, this.segmentMs);
            recording.timer.unref();
            this.recording = recording;
        } catch (error: unknown) {
            page.close();

            throw error;
        }
    }

    // The text so far, for a bot that is asked during the meeting.
    status(botId: string): string | undefined {
        const recording = this.recording;

        if (recording?.botId !== botId) {
            return undefined;
        }

        const minutes = Math.floor((this.now() - recording.startedAt) / 60_000);
        const text = recording.lines.length === 0 ? 'No speech transcribed yet. Each part is transcribed after it ends, about every 5 minutes.' : recording.lines.join('\n');

        return `Recording for ${String(minutes)} min.\n${text}`;
    }

    // Takes the last part, waits for its text and saves the transcript.
    async stop(botId: string): Promise<MeetingResult | undefined> {
        const recording = this.recording;

        if (recording?.botId !== botId) {
            return undefined;
        }

        return this.finish(recording);
    }

    // Called once: the recording leaves this.recording first, so a part taken at the same time does not finish it again.
    private async finish(recording: MeetingRecording): Promise<MeetingResult> {
        this.recording = undefined;
        clearInterval(recording.timer);
        // A part taken right now restarts the page recorder, so the last take waits for it.
        await recording.taking;

        const segment = await this.takeAudio(recording, false);

        this.queueTranscript(recording, segment);
        recording.page.close();
        await recording.transcribing;

        const header = `# Meeting transcript\n\nStarted ${new Date(recording.startedAt)
            .toISOString()}. Each line starts at its time in the meeting.\n\n`;
        const body = recording.lines.length === 0 ? 'No speech was transcribed.' : recording.lines.join('\n');
        const fileName = transcriptFileName(recording.startedAt);
        const transcriptPath = await this.options.saveTranscript(recording.botId, fileName, `${header}${body}\n`);

        return { transcriptPath, lineCount: recording.lines.length, failedSegments: recording.failedSegments };
    }

    // Runs on the timer. It ends the recording when the meeting has ended or runs too long.
    private async takeSegment(recording: MeetingRecording): Promise<void> {
        if (this.recording !== recording || recording.taking !== undefined) {
            return;
        }

        const taking = this.takeAudio(recording, true);

        recording.taking = taking.then(() => undefined);

        const segment = await taking;

        recording.taking = undefined;
        this.queueTranscript(recording, segment);
        recording.quietSegments = segment === undefined || segment.liveTracks === 0 ? recording.quietSegments + 1 : 0;

        const hasEnded = segment === undefined || recording.quietSegments >= QUIET_SEGMENTS_TO_END;
        const isTooLong = this.now() - recording.startedAt >= this.maxMeetingMs;

        // The bot may have stopped it while the part was taken.
        if (this.recording !== recording || (!hasEnded && !isTooLong)) {
            return;
        }

        const result = await this.finish(recording);

        this.options.onEnded(recording.botId, result.transcriptPath);
    }

    // Undefined when the page left the meeting or the browser closed. The parts so far are kept.
    private async takeAudio(recording: MeetingRecording, keepRecording: boolean): Promise<TakenSegment | undefined> {
        const offsetMs = recording.segmentStartedAt - recording.startedAt;

        try {
            const result = await evaluateInPage(recording.page, pageTakeMeetingRecording, [keepRecording], { contextId: recording.contextId, awaitPromise: true, returnByValue: true, timeoutMs: EVALUATE_TIMEOUT_MS });
            const value = readEvaluatedValue(result);
            const segment = readTakenSegment(value);

            return { ...segment, offsetMs };
        } catch {
            return undefined;
        } finally {
            recording.segmentStartedAt = this.now();
        }
    }

    private queueTranscript(recording: MeetingRecording, segment: TakenSegment | undefined): void {
        if (segment === undefined || segment.audio === '') {
            return;
        }

        const audio = Buffer.from(segment.audio, 'base64');
        const offsetMs = segment.offsetMs;

        recording.transcribing = recording.transcribing.then(() => this.transcribeSegment(recording, audio, offsetMs));
    }

    private async transcribeSegment(recording: MeetingRecording, audio: Buffer, offsetMs: number): Promise<void> {
        try {
            const text = await this.options.transcribe(audio, recording.language);

            if (text !== '') {
                recording.lines.push(`[${formatOffset(offsetMs)}] ${text}`);
            }
        } catch {
            recording.failedSegments += 1;
        }
    }
}

export { MeetingRecorder, MeetingRecorderError, formatOffset, isMeetingUrl, transcriptFileName };
export type { MeetingRecorderOptions, MeetingResult };
