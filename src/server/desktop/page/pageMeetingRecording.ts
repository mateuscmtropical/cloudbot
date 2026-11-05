interface MeetingTake {
    audio: string;
    liveTracks: number;
}

interface MeetingHandle {
    take: (keepRecording: boolean) => Promise<MeetingTake>;
}

interface MeetingGlobal {
    cloudbotMeeting?: MeetingHandle | undefined;
}

// Runs in an isolated world of the meeting page, so the page cannot see or change it. The DOM is shared,
// so it reads the audio of every <audio> and <video> element the page plays, mixes it and records it.
// New elements are picked up every 2 seconds, since a meeting adds one for each person who speaks.
// It works with no sound card: the AudioContext only feeds the recorder.
function pageStartMeetingRecording(): string | Promise<string> {
    const scope = globalThis as unknown as MeetingGlobal;

    if (scope.cloudbotMeeting !== undefined) {
        return 'running';
    }

    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const attachedStreams = new Set<MediaStream>();
    const attach = (): void => {
        const elements = document.querySelectorAll('audio, video');

        elements.forEach((element) => {
            const stream = (element as HTMLMediaElement).srcObject;

            if (!(stream instanceof MediaStream) || attachedStreams.has(stream) || stream.getAudioTracks().length === 0) {
                return;
            }

            attachedStreams.add(stream);

            const source = context.createMediaStreamSource(stream);

            source.connect(destination);
        });
    };
    const countLiveTracks = (): number => {
        const tracks = [...attachedStreams].flatMap(stream => stream.getAudioTracks());

        return tracks.filter(track => track.readyState === 'live').length;
    };
    let chunks: Blob[] = [];
    const createRecorder = (): MediaRecorder => {
        chunks = [];

        const created = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });

        created.ondataavailable = (event) => {
            if (event.data.size > 0) {
                chunks.push(event.data);
            }
        };
        created.start(1000);

        return created;
    };
    const toBase64 = (blob: Blob): Promise<string> => new Promise((resolve) => {
        const reader = new FileReader();

        reader.onload = () => {
            const dataUrl = typeof reader.result === 'string' ? reader.result : '';
            const parts = dataUrl.split(',');

            resolve(parts[1] ?? '');
        };
        reader.readAsDataURL(blob);
    });
    const timer = setInterval(attach, 2000);

    attach();

    let recorder = createRecorder();

    scope.cloudbotMeeting = {
        take: keepRecording => new Promise((resolve) => {
            const finishedRecorder = recorder;
            const finishedChunks = chunks;

            finishedRecorder.onstop = () => {
                const liveTracks = countLiveTracks();

                if (keepRecording) {
                    recorder = createRecorder();
                } else {
                    clearInterval(timer);
                    void context.close();
                    scope.cloudbotMeeting = undefined;
                }

                const blob = new Blob(finishedChunks, { type: 'audio/webm' });

                void toBase64(blob)
                    .then((audio) => {
                        resolve({ audio, liveTracks });
                    });
            };
            finishedRecorder.stop();
        }),
    };

    return context.resume()
        .then(() => context.state);
}

// Runs in the same isolated world. Takes the audio recorded since the last take, and optionally keeps recording.
function pageTakeMeetingRecording(keepRecording: boolean): MeetingTake | Promise<MeetingTake> {
    const scope = globalThis as unknown as MeetingGlobal;

    if (scope.cloudbotMeeting === undefined) {
        return { audio: '', liveTracks: 0 };
    }

    return scope.cloudbotMeeting.take(keepRecording);
}

export { pageStartMeetingRecording, pageTakeMeetingRecording };
