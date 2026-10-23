import type { Person, PersonWithPassword, ResetPasswordResult } from '../../shared/peopleTypes.ts';

// What the owner's instance can ask the hub to do about people. The people panel and the bot tools both use it.
interface PeopleAdmin {
    list: () => Promise<Person[]>;
    add: (name: string) => Promise<PersonWithPassword>;
    deactivate: (name: string) => Promise<Person>;
    reactivate: (name: string) => Promise<Person>;
    resetPassword: (name: string) => Promise<ResetPasswordResult>;
    remove: (name: string) => Promise<void>;
}

// The hub refused or failed. The message is safe to show the owner.
class PeopleAdminError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'PeopleAdminError';
        this.status = status;
    }
}

export { PeopleAdminError };
export type { PeopleAdmin };
