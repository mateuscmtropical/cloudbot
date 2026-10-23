import { timingSafeEqual } from 'node:crypto';

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

export { isValidHubSecret };
