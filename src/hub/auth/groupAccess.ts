import { randomBytes } from 'node:crypto';

import type { GroupRole } from '../../shared/peopleTypes.ts';
import type { GroupMembersStore, PersonRecord } from '../contract.ts';

// Who is behind a request to an instance. A person's own address takes only that person. A group's address takes its
// members, and the instance learns who acts and in what role.
interface ActingPerson {
    name: string;
    // Set on a group's address only.
    groupRole?: GroupRole;
}

interface EntryTicket {
    groupName: string;
    personName: string;
    expiresAt: number;
}

const ENTRY_TOKEN_BYTES = 32;
// The browser follows the redirect at once, so a minute is plenty.
const ENTRY_TOKEN_LIFETIME_MS = 60 * 1000;

// Without the members store, a group's address takes nobody.
function readActingPerson(host: PersonRecord, sessionName: string, members: GroupMembersStore | undefined): ActingPerson | undefined {
    if (host.role !== 'group') {
        return sessionName === host.name ? { name: sessionName } : undefined;
    }

    const groupRole = members?.roleOf(host.name, sessionName);

    return groupRole === undefined ? undefined : { name: sessionName, groupRole };
}

// Each address keeps its own cookie, so the session of a person does not reach a group's address by itself. The person's
// own address hands out a ticket for one group, and the group's address trades it for a session of that person.
class GroupEntryTickets {
    private readonly tickets = new Map<string, EntryTicket>();

    issue(groupName: string, personName: string, now: number): string {
        this.forgetExpired(now);

        const tokenBytes = randomBytes(ENTRY_TOKEN_BYTES);
        const token = tokenBytes.toString('base64url');

        this.tickets.set(token, { groupName, personName, expiresAt: now + ENTRY_TOKEN_LIFETIME_MS });

        return token;
    }

    // A ticket works once, and only on the address of its group.
    redeem(token: string, groupName: string, now: number): string | undefined {
        const ticket = this.tickets.get(token);

        this.tickets.delete(token);

        if (ticket === undefined || ticket.groupName !== groupName || ticket.expiresAt <= now) {
            return undefined;
        }

        return ticket.personName;
    }

    private forgetExpired(now: number): void {
        this.tickets.forEach((ticket, token) => {
            if (ticket.expiresAt <= now) {
                this.tickets.delete(token);
            }
        });
    }
}

export { GroupEntryTickets, readActingPerson };
export type { ActingPerson };
