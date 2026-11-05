import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { createVoiceRoutes } from './createVoiceRoutes.ts';
import { VoiceBusyError, VoiceFormatError, VoiceUnavailableError, cleanTranscript, createVoiceTranscriber, detectAudioFormat, whisperLanguage } from './transcribeAudio.ts';
import type { RunProgram, TranscribeAudio } from './transcribeAudio.ts';

const PROGRAMS = { ffmpeg: 'ffmpeg-path', whisper: 'whisper-path', model: 'model.bin', vadModel: 'vad.bin' };
const WEBM_AUDIO = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3]);

const folders: string[] = [];

function tempWorkDir(): string {
    const folder = mkdtempSync(join(tmpdir(), 'voice-test-'));

    folders.push(folder);

    return join(folder, 'jobs');
}

function textReply(text: string): RunProgram {
    return (program, args) => {
        if (program === PROGRAMS.ffmpeg) {
            return writeFile(args.at(-1) ?? '', 'wav')
                .then(() => '');
        }

        return Promise.resolve(text);
    };
}

afterEach(() => {
    folders.splice(0)
        .forEach((folder) => {
            rmSync(folder, { recursive: true, force: true });
        });
});

describe('detectAudioFormat', () => {
    it('names the format from the first bytes', () => {
        const mp4 = Buffer.from('\0\0\0\u0018ftypmp42', 'latin1');
        const wave = Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1');

        expect(detectAudioFormat(WEBM_AUDIO))
            .toBe('matroska');
        expect(detectAudioFormat(Buffer.from('OggS\0', 'latin1')))
            .toBe('ogg');
        expect(detectAudioFormat(mp4))
            .toBe('mov');
        expect(detectAudioFormat(wave))
            .toBe('wav');
    });

    it('refuses a playlist or a concat file', () => {
        expect(detectAudioFormat(Buffer.from('#EXTM3U\nfile:///etc/passwd')))
            .toBeUndefined();
        expect(detectAudioFormat(Buffer.from('ffconcat version 1.0')))
            .toBeUndefined();
    });
});

describe('whisperLanguage', () => {
    it('keeps the base language and detects anything else', () => {
        expect(whisperLanguage('pt-BR'))
            .toBe('pt');
        expect(whisperLanguage(undefined))
            .toBe('auto');
        expect(whisperLanguage('--model'))
            .toBe('auto');
    });
});

describe('cleanTranscript', () => {
    it('joins the lines and drops the noise marks', () => {
        expect(cleanTranscript(' Hello there\n[BLANK_AUDIO]\n(music)\n how are you\n'))
            .toBe('Hello there how are you');
    });
});

describe('createVoiceTranscriber', () => {
    it('converts, transcribes, and deletes the audio when the job ends', async () => {
        const workDir = tempWorkDir();
        const calls: { program: string; args: string[] }[] = [];
        const run = textReply('hello\n');
        let storedAudio: Buffer | undefined;
        let folderMode = 0;
        const transcribe = createVoiceTranscriber({
            workDir,
            programs: PROGRAMS,
            runProgram: async (program, args, timeoutMs) => {
                calls.push({ program, args });
                storedAudio ??= await readFile(join(workDir, 'input'));
                folderMode = statSync(workDir).mode & 0o777;

                return run(program, args, timeoutMs);
            },
        });

        await expect(transcribe(WEBM_AUDIO, 'pt-BR')).resolves.toBe('hello');

        expect(storedAudio?.equals(WEBM_AUDIO))
            .toBe(true);
        expect(existsSync(workDir))
            .toBe(false);
        expect(calls[0]?.args)
            .toEqual(expect.arrayContaining(['-protocol_whitelist', 'file', '-f', 'matroska', '-ar', '16000', '-ac', '1']));
        expect(calls[1]?.args)
            .toEqual(expect.arrayContaining(['-l', 'pt', '--vad', '-vm', 'vad.bin', '-m', 'model.bin']));

        if (process.platform !== 'win32') {
            expect(folderMode)
                .toBe(0o700);
        }
    });

    it('never starts a program for an unknown format', async () => {
        const calls: string[] = [];
        const transcribe = createVoiceTranscriber({
            workDir: tempWorkDir(),
            programs: PROGRAMS,
            runProgram: (program) => {
                calls.push(program);

                return Promise.resolve('');
            },
        });

        await expect(transcribe(Buffer.from('#EXTM3U'), undefined)).rejects.toBeInstanceOf(VoiceFormatError);
        expect(calls)
            .toEqual([]);
    });

    it('runs one job at a time, and takes the next one after it', async () => {
        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const transcribe = createVoiceTranscriber({
            workDir: tempWorkDir(),
            programs: PROGRAMS,
            runProgram: () => gate.then(() => 'done'),
        });
        const first = transcribe(WEBM_AUDIO, undefined);

        await expect(transcribe(WEBM_AUDIO, undefined)).rejects.toBeInstanceOf(VoiceBusyError);
        release();
        await expect(first).resolves.toBe('done');
        await expect(transcribe(WEBM_AUDIO, undefined)).resolves.toBe('done');
    });

    it('deletes the audio after a failed job, and says when a program is missing', async () => {
        const workDir = tempWorkDir();
        const missing = Object.assign(new Error('spawn'), { code: 'ENOENT' });
        const transcribe = createVoiceTranscriber({
            workDir,
            programs: PROGRAMS,
            runProgram: () => Promise.reject(missing),
        });

        await expect(transcribe(WEBM_AUDIO, undefined)).rejects.toBeInstanceOf(VoiceUnavailableError);
        expect(existsSync(workDir))
            .toBe(false);
    });
});

describe('createVoiceRoutes', () => {
    function post(transcribe: TranscribeAudio, form: FormData, query = ''): Promise<Response> {
        const app = new Hono();
        const routes = createVoiceRoutes({ transcribe, maxUploadBytes: 1024 });

        app.route('/', routes);

        return Promise.resolve(app.request(`/api/voice/transcribe${query}`, { method: 'POST', body: form }));
    }

    function audioForm(size = 8): FormData {
        const form = new FormData();
        const bytes = new Uint8Array(size);

        form.append('file', new File([bytes], 'voice.webm'));

        return form;
    }

    it('answers with the text and passes the language on', async () => {
        const languages: (string | undefined)[] = [];
        const form = audioForm();
        const response = await post((_audio, language) => {
            languages.push(language);

            return Promise.resolve('hello');
        }, form, '?language=pt-BR');

        expect(response.status)
            .toBe(200);
        await expect(response.json()).resolves.toEqual({ text: 'hello' });
        expect(languages)
            .toEqual(['pt-BR']);
    });

    it('refuses a request without audio and a body over the limit', async () => {
        const transcribe: TranscribeAudio = () => Promise.resolve('never');
        const emptyForm = new FormData();
        const empty = await post(transcribe, emptyForm);
        const largeForm = audioForm(4096);
        const large = await post(transcribe, largeForm);

        expect(empty.status)
            .toBe(400);
        expect(large.status)
            .toBe(413);
    });

    it('maps the errors to their status without showing internal details', async () => {
        const form = audioForm();
        const busy = await post(() => Promise.reject(new VoiceBusyError('busy')), form);
        const format = await post(() => Promise.reject(new VoiceFormatError('format')), form);
        const missing = await post(() => Promise.reject(new VoiceUnavailableError('missing')), form);
        const failed = await post(() => Promise.reject(new Error('/var/lib/secret/path')), form);
        const failedBody = await failed.text();

        expect([busy.status, format.status, missing.status, failed.status])
            .toEqual([429, 415, 503, 500]);
        expect(failedBody)
            .not.toContain('secret');
    });
});
