import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';

import { INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../../shared/hubProtocol.ts';
import type { PeopleStore, PersonRecord } from '../contract.ts';

function hasMatchingSecret(candidate: string, expected: string): boolean {
    const candidateDigest = createHash('sha256')
        .update(candidate)
        .digest();
    const expectedDigest = createHash('sha256')
        .update(expected)
        .digest();

    return timingSafeEqual(candidateDigest, expectedDigest);
}

// The person whose instance made the call, by the name and secret the hub gave it. A group's instance is nobody here.
function authorizeInstance(context: Context, people: PeopleStore): PersonRecord | undefined {
    const instanceName = context.req.header(INSTANCE_NAME_HEADER);
    const instanceSecret = context.req.header(INSTANCE_SECRET_HEADER);

    if (instanceName === undefined || instanceSecret === undefined) {
        return undefined;
    }

    const person = people.find(instanceName);

    if (person === undefined || person.role === 'group' || person.state !== 'active' || !hasMatchingSecret(instanceSecret, person.instanceSecret)) {
        return undefined;
    }

    return person;
}

function authorizeOwner(context: Context, people: PeopleStore): PersonRecord | undefined {
    const person = authorizeInstance(context, people);

    return person?.role === 'owner' ? person : undefined;
}

// The address a person or a group opens, for example https://maria.example.com
function addressOf(name: string, domain: string, secure: boolean): string {
    if (domain === 'localhost') {
        return `http://${name}.localhost`;
    }

    const scheme = secure ? 'https' : 'http';

    return `${scheme}://${name}.${domain}`;
}

export { addressOf, authorizeInstance, authorizeOwner };
