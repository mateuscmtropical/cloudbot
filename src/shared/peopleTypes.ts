// The people the owner invites to one CloudBot server. Each person has their own instance.
// A shared group is kept with them, under the role group: it has its own instance and address, and nobody signs in as it.
type PersonRole = 'owner' | 'member' | 'group';

// The place of a person in a shared group. The owner made the group and cannot be removed. An admin manages the people
// and approves what spends money. A member takes part.
type GroupRole = 'owner' | 'admin' | 'member';

interface GroupMember {
    name: string;
    role: GroupRole;
}

// A shared group, as the server owner sees it.
interface SharedGroup {
    name: string;
    address: string;
    instance: InstanceStatus;
    members: GroupMember[];
    createdAt: number;
}

// A shared group, as one of its members sees it in their own CloudBot.
interface MyGroup {
    name: string;
    // Opens the group with the session of the person, through the hub.
    openPath: string;
    role: GroupRole;
}

interface AddGroupRequest {
    name: string;
}

interface SetGroupMemberRequest {
    role: 'admin' | 'member';
}

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

// The state of an update of the whole install. An install without the update service is unavailable.
type AppUpdateState = 'idle' | 'running' | 'done' | 'failed' | 'unavailable';

interface AppUpdateStatus {
    state: AppUpdateState;
    commit?: string;
    latest?: string;
    at?: string;
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
export type { AddGroupRequest, AddPersonRequest, AppUpdateState, AppUpdateStatus, GroupMember, GroupRole, InstanceStatus, MyGroup, PeopleErrorResponse, Person, PersonRole, PersonState, PersonWithPassword, ResetPasswordResult, SetGroupMemberRequest, SharedGroup };
