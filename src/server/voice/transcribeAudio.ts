import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

interface VoicePrograms {
    ffmpeg: string;
    whisper: string;
    model: string;
    vadModel: string;
}

// Runs one program to its end and returns what it printed. It rejects when the program fails or runs too long.
type RunProgram = (program: string, args: string[], timeoutMs: number) => Promise<string>;

interface VoiceTranscriberOptions {
    // A private folder of the server user, so the bot user cannot open the audio.
    workDir: string;
    programs: VoicePrograms;
    runProgram?: RunProgram;
}

type TranscribeAudio = (audio: Buffer, language: string | undefined) => Promise<string>;

class VoiceBusyError extends Error {}

class VoiceFormatError extends Error {}

class VoiceUnavailableError extends Error {}

const runFile = promisify(execFile);
const DEFAULT_PROGRAMS: VoicePrograms = {
    ffmpeg: '/usr/bin/ffmpeg',
    whisper: '/usr/local/lib/cloudbot/whisper/whisper-cli',
    model: '/usr/local/lib/cloudbot/whisper/ggml-base.bin',
    vadModel: '/usr/local/lib/cloudbot/whisper/ggml-silero.bin',
};
const MAX_AUDIO_SECONDS = 360;
const CONVERT_TIMEOUT_MS = 60_000;
// A small Arm server takes about as long as the audio lasts, and a busy one takes longer.
const TRANSCRIBE_TIMEOUT_MS = 900_000;
// An instance has 1.5 CPUs, and more threads than that only make them wait for each other.
const WHISPER_THREADS = 2;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const LANGUAGE_PATTERN = /^[a-z]{2,3}$/;
// Whisper marks silence and noise with lines such as [BLANK_AUDIO] or (music), which nobody said.
const NOISE_LINE_PATTERN = /^(?:\[.*\]|\(.*\))$/;
const MATROSKA_SIGNATURE = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]);

// The input format comes from the first bytes and is named to ffmpeg, so a playlist or a concat file never opens another file.
function detectAudioFormat(header: Buffer): string | undefined {
    const riffMarker = header.subarray(0, 4)
        .toString('latin1');
    const waveMarker = header.subarray(8, 12)
        .toString('latin1');
    const mp4Marker = header.subarray(4, 8)
        .toString('latin1');
    const matroskaPrefix = header.subarray(0, MATROSKA_SIGNATURE.length);

    if (matroskaPrefix.equals(MATROSKA_SIGNATURE)) {
        return 'matroska';
    }

    if (riffMarker === 'OggS') {
        return 'ogg';
    }

    if (mp4Marker === 'ftyp') {
        return 'mov';
    }

    if (riffMarker === 'RIFF' && waveMarker === 'WAVE') {
        return 'wav';
    }

    return undefined;
}

// "pt-BR" becomes "pt". Anything else lets whisper detect the language.
function whisperLanguage(language: string | undefined): string {
    const baseLanguage = language?.split('-')[0]
        ?.toLowerCase() ?? '';

    return LANGUAGE_PATTERN.test(baseLanguage) ? baseLanguage : 'auto';
}

function cleanTranscript(output: string): string {
    const lines = output.split('\n')
        .map(line => line.trim());
    const spokenLines = lines.filter(line => line !== '' && !NOISE_LINE_PATTERN.test(line));

    return spokenLines.join(' ');
}

// The programs get no secret from the server's environment, and no shell reads the arguments.
async function runWithoutSecrets(program: string, args: string[], timeoutMs: number): Promise<string> {
    const { stdout } = await runFile(program, args, { env: {}, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES });

    return stdout;
}

function isMissingProgram(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function readVoicePrograms(environment: NodeJS.ProcessEnv): VoicePrograms {
    return {
        ffmpeg: environment.CLOUDBOT_FFMPEG_PATH ?? DEFAULT_PROGRAMS.ffmpeg,
        whisper: environment.CLOUDBOT_WHISPER_PATH ?? DEFAULT_PROGRAMS.whisper,
        model: environment.CLOUDBOT_WHISPER_MODEL ?? DEFAULT_PROGRAMS.model,
        vadModel: environment.CLOUDBOT_WHISPER_VAD_MODEL ?? DEFAULT_PROGRAMS.vadModel,
    };
}

// One job at a time, and each job is its own short process, so an idle server holds no model in memory.
// ponytail: a second request is refused instead of queued. One person uses one instance, so a queue has little to do.
function createVoiceTranscriber(options: VoiceTranscriberOptions): TranscribeAudio {
    const { workDir, programs, runProgram = runWithoutSecrets } = options;
    let isBusy = false;

    async function runJob(audio: Buffer, format: string, language: string | undefined): Promise<string> {
        const inputPath = join(workDir, 'input');
        const wavPath = join(workDir, 'speech.wav');

        await rm(workDir, { recursive: true, force: true });
        await mkdir(workDir, { recursive: true, mode: 0o700 });
        await writeFile(inputPath, audio, { mode: 0o600 });
        await runProgram(programs.ffmpeg, [
            '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1',
            '-protocol_whitelist', 'file', '-f', format, '-i', inputPath,
            '-vn', '-t', String(MAX_AUDIO_SECONDS), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath,
        ], CONVERT_TIMEOUT_MS);

        const output = await runProgram(programs.whisper, [
            '-m', programs.model, '-f', wavPath, '-l', whisperLanguage(language), '-t', String(WHISPER_THREADS),
            '-nt', '-np', '--vad', '-vm', programs.vadModel,
        ], TRANSCRIBE_TIMEOUT_MS);

        return cleanTranscript(output);
    }

    return async (audio, language) => {
        const format = detectAudioFormat(audio);

        if (format === undefined) {
            throw new VoiceFormatError('This audio format is not supported.');
        }

        if (isBusy) {
            throw new VoiceBusyError('Another recording is being transcribed. Try again in a moment.');
        }

        isBusy = true;

        try {
            return await runJob(audio, format, language);
        } catch (error: unknown) {
            if (isMissingProgram(error)) {
                throw new VoiceUnavailableError('Voice transcription is not installed on this server.');
            }

            throw error;
        } finally {
            await rm(workDir, { recursive: true, force: true });
            isBusy = false;
        }
    };
}

export { VoiceBusyError, VoiceFormatError, VoiceUnavailableError, cleanTranscript, createVoiceTranscriber, detectAudioFormat, readVoicePrograms, whisperLanguage };
export type { RunProgram, TranscribeAudio, VoicePrograms, VoiceTranscriberOptions };
