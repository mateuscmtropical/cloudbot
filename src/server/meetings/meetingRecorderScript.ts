// Runs in an isolated world of the meeting page, so the page cannot see or change it. The DOM is shared,
// so it reads the audio of every <audio> and <video> element the page plays, mixes it and records it.
// New elements are picked up every 2 seconds, since a meeting adds one for each person who speaks.
// It works with no sound card: the AudioContext only feeds the recorder.
const RECORDER_START_EXPRESSION = `(() => {
    if (globalThis.cloudbotMeeting !== undefined) {
        return 'running';
    }

    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const attachedStreams = new Set();
    const attach = () => {
        document.querySelectorAll('audio, video').forEach((element) => {
            const stream = element.srcObject;

            if (!(stream instanceof MediaStream) || attachedStreams.has(stream) || stream.getAudioTracks().length === 0) {
                return;
            }

            attachedStreams.add(stream);
            context.createMediaStreamSource(stream).connect(destination);
        });
    };
    const countLiveTracks = () => [...attachedStreams]
        .flatMap(stream => stream.getAudioTracks())
        .filter(track => track.readyState === 'live').length;
    let chunks = [];
    let recorder;
    const startRecorder = () => {
        chunks = [];
        recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });
        recorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                chunks.push(event.data);
            }
        };
        recorder.start(1000);
    };
    const toBase64 = blob => new Promise((resolve) => {
        const reader = new FileReader();

        reader.onload = () => {
            resolve(String(reader.result).split(',')[1] ?? '');
        };
        reader.readAsDataURL(blob);
    });
    const timer = setInterval(attach, 2000);

    attach();
    startRecorder();
    globalThis.cloudbotMeeting = {
        take: keepRecording => new Promise((resolve) => {
            const finishedRecorder = recorder;
            const finishedChunks = chunks;

            finishedRecorder.onstop = () => {
                const liveTracks = countLiveTracks();

                if (keepRecording) {
                    startRecorder();
                } else {
                    clearInterval(timer);
                    void context.close();
                    globalThis.cloudbotMeeting = undefined;
                }

                void toBase64(new Blob(finishedChunks, { type: 'audio/webm' }))
                    .then(audio => resolve({ audio, liveTracks }));
            };
            finishedRecorder.stop();
        }),
    };

    return context.resume().then(() => context.state);
})()`;

function recorderTakeExpression(keepRecording: boolean): string {
    return `globalThis.cloudbotMeeting === undefined ? { audio: '', liveTracks: 0 } : globalThis.cloudbotMeeting.take(${String(keepRecording)})`;
}

const PAGE_URL_EXPRESSION = 'location.href';

export { PAGE_URL_EXPRESSION, RECORDER_START_EXPRESSION, recorderTakeExpression };
