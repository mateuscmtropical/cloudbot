// The people the owner invites to one CloudBot server. Each person has their own instance.
type PersonRole = 'owner' | 'member';

// An inactive person cannot sign in and their instance is stopped. Their data stays.
type PersonState = 'active' | 'inactive';

// missing: no container yet. stopped: the container exists and is off. starting: it was started and is not healthy yet.
type InstanceStatus = 'missing' | 'stopped' | 'starting' | 'running';

interface Person {
    name: string;
    role: PersonRole;
    state: PersonState;
    instance: InstanceStatus;
    // The URL the person opens, for example https://maria.example.com
    address: string;
    createdAt: number;
    lastSeenAt: number | null;
}

interface AddPersonRequest {
    name: string;
}

// A generated password is shown to the owner once. It is never stored and never goes to the model.
interface PersonWithPassword {
    person: Person;
    password: string;
}

interface ResetPasswordResult {
    password: string;
}

interface PeopleErrorResponse {
    error: string;
}

const PERSON_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,28}[a-z0-9])$/;

// These names are taken by the hub, the proxy or common services, so no person can use them as a subdomain.
const RESERVED_PERSON_NAMES: readonly string[] = ['www', 'hub', 'admin', 'api', 'mail', 'caddy', 'docker', 'proxy', 'localhost', 'cloudbot'];

// Returns the reason a name cannot be used, or undefined when it can.
function checkPersonName(name: string): string | undefined {
    if (!PERSON_NAME_PATTERN.test(name)) {
        return 'Use 2 to 30 lowercase letters, digits or hyphens. Start with a letter and do not end with a hyphen.';
    }

    if (RESERVED_PERSON_NAMES.includes(name)) {
        return 'That name is reserved. Pick another one.';
    }

    return undefined;
}

export { PERSON_NAME_PATTERN, RESERVED_PERSON_NAMES, checkPersonName };
export type { AddPersonRequest, InstanceStatus, PeopleErrorResponse, Person, PersonRole, PersonState, PersonWithPassword, ResetPasswordResult };
