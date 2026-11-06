import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';

import { ACTING_PERSON_HEADER, ACTING_ROLE_HEADER, HUB_TRUST_HEADER } from '../../shared/hubProtocol.ts';
import type { GroupRole } from '../../shared/peopleTypes.ts';

// The person who acts in a shared group, as the hub tells it.
interface ActingPerson {
    name: string;
    role: GroupRole;
}

const GROUP_ROLES: readonly GroupRole[] = ['owner', 'admin', 'member'];

function isValidHubSecret(candidate: string | undefined, expected: string | undefined): boolean {
    if (candidate === undefined || expected === undefined) {
        return false;
    }

    const candidateBytes = Buffer.from(candidate);
    const expectedBytes = Buffer.from(expected);

    if (candidateBytes.length !== expectedBytes.length) {
        return false;
    }

    return timingSafeEqual(candidateBytes, expectedBytes);
}

// Trusted only next to the hub secret, so a program inside the container cannot claim to be someone.
function readActingPerson(context: Context, hubSecret: string | undefined): ActingPerson | undefined {
    const presentedSecret = context.req.header(HUB_TRUST_HEADER);

    if (!isValidHubSecret(presentedSecret, hubSecret)) {
        return undefined;
    }

    const name = context.req.header(ACTING_PERSON_HEADER);
    const roleText = context.req.header(ACTING_ROLE_HEADER);
    const role = GROUP_ROLES.find(candidate => candidate === roleText);

    return name === undefined || name === '' || role === undefined ? undefined : { name, role };
}

export { isValidHubSecret, readActingPerson };
export type { ActingPerson };
