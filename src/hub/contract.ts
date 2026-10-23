import type { InstanceStatus, PersonRole, PersonState } from '../shared/peopleTypes.ts';

// What the hub keeps about one person. The password is a scrypt hash. The instance secret is random, made when the
// person is added, and is the only thing that lets the hub talk to that instance.
interface PersonRecord {
    name: string;
    role: PersonRole;
    state: PersonState;
    passwordHash: string;
    // A generated password must be changed at the first sign-in.
    mustChangePassword: boolean;
    instanceSecret: string;
    createdAt: number;
    lastSeenAt: number | null;
}

type PersonUpdate = Partial<Pick<PersonRecord, 'state' | 'passwordHash' | 'mustChangePassword' | 'lastSeenAt'>>;

// The people table of the hub database. Names are unique.
interface PeopleStore {
    list: () => PersonRecord[];
    find: (name: string) => PersonRecord | undefined;
    add: (record: PersonRecord) => void;
    update: (name: string, update: PersonUpdate) => void;
    remove: (name: string) => void;
}

// busy: starting one more instance would pass the memory budget, so the person waits and tries again.
type StartResult = 'running' | 'busy';

// Controls the containers. The only code that talks to Docker, and only through the socket proxy.
interface InstanceManager {
    status: (name: string) => Promise<InstanceStatus>;
    // Makes the container, its network and its volumes. It does not start it.
    create: (record: PersonRecord) => Promise<void>;
    // Starts the container if needed and resolves when it is healthy.
    start: (name: string) => Promise<StartResult>;
    stop: (name: string) => Promise<void>;
    // Removes the container, its network and its volumes.
    remove: (name: string) => Promise<void>;
}

export type { InstanceManager, PeopleStore, PersonRecord, PersonUpdate, StartResult };
