import type { PersonRole } from '../../shared/peopleTypes.ts';

// The hub gives these to the instance it starts. A server run on its own has none of them.
interface HubConfig {
    hubUrl: string;
    // The secret of this instance. The hub sends it in a header, and this instance sends it back to call the hub.
    secret: string;
    personName: string;
    role: PersonRole;
}

// Returns undefined when the server runs on its own. A half set configuration stops the start with a clear error.
function readHubConfig(env: NodeJS.ProcessEnv): HubConfig | undefined {
    const secret = env.CLOUDBOT_HUB_SECRET;

    if (secret === undefined || secret === '') {
        return undefined;
    }

    const hubUrl = env.CLOUDBOT_HUB_URL;
    const personName = env.CLOUDBOT_PERSON_NAME;
    const role = env.CLOUDBOT_PERSON_ROLE;

    if (hubUrl === undefined || hubUrl === '' || personName === undefined || personName === '') {
        throw new Error('CLOUDBOT_HUB_SECRET needs CLOUDBOT_HUB_URL and CLOUDBOT_PERSON_NAME.');
    }

    if (role !== 'owner' && role !== 'member') {
        throw new Error('CLOUDBOT_PERSON_ROLE must be owner or member.');
    }

    return { hubUrl, secret, personName, role };
}

export { readHubConfig };
export type { HubConfig };
