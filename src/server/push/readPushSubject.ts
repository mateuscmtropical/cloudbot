// The contact that VAPID names for the push service, which may use it to reach whoever runs the server. It must be an
// https or mailto address. The public address of this server is the best contact, and the project page is the fallback.
const PROJECT_URL = 'https://github.com/mateuscmtropical/cloudbot';

function readPushSubject(environment: NodeJS.ProcessEnv): string {
    const publicUrl = environment.CLOUDBOT_PUBLIC_URL;

    if (publicUrl === undefined) {
        return PROJECT_URL;
    }

    try {
        const parsed = new URL(publicUrl);

        return parsed.protocol === 'https:' ? parsed.origin : PROJECT_URL;
    } catch {
        return PROJECT_URL;
    }
}

export { PROJECT_URL, readPushSubject };
