// The Google Cloud OAuth client of the server. The admin sets it once in the install .env. The hub reads it and
// gives it to each instance it starts, and a server that runs on its own reads it directly. It never goes to the
// bot, since the sign-in and the token exchange both run in the server process.

interface GoogleClientEnv {
    clientId: string;
    clientSecret: string;
}

const GOOGLE_CLIENT_ID_ENV = 'CLOUDBOT_GOOGLE_CLIENT_ID';
const GOOGLE_CLIENT_SECRET_ENV = 'CLOUDBOT_GOOGLE_CLIENT_SECRET';

// Returns undefined when neither line is set. A half set client stops the start with a clear error.
function readGoogleClientEnv(env: Record<string, string | undefined>): GoogleClientEnv | undefined {
    const clientId = (env[GOOGLE_CLIENT_ID_ENV] ?? '').trim();
    const clientSecret = (env[GOOGLE_CLIENT_SECRET_ENV] ?? '').trim();

    if (clientId === '' && clientSecret === '') {
        return undefined;
    }

    if (clientId === '' || clientSecret === '') {
        throw new Error(`${GOOGLE_CLIENT_ID_ENV} and ${GOOGLE_CLIENT_SECRET_ENV} go together. Set both or neither.`);
    }

    return { clientId, clientSecret };
}

export { GOOGLE_CLIENT_ID_ENV, GOOGLE_CLIENT_SECRET_ENV, readGoogleClientEnv };
export type { GoogleClientEnv };
