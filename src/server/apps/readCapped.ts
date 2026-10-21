import { Transform, pipeline } from 'node:stream';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

class BodyTooLargeError extends Error {}

// Reads a stream in full. Past maxBytes the read fails with BodyTooLargeError, and the source is destroyed, so nothing more is read.
async function readCapped(source: Readable, maxBytes: number): Promise<Buffer> {
    let received = 0;
    const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;

            if (received > maxBytes) {
                callback(new BodyTooLargeError('The body is too large.'));

                return;
            }

            callback(null, chunk);
        },
    });
    // pipeline destroys both streams on an error, and the error then reaches the buffer read below.
    const counted = pipeline(source, counter, () => undefined);

    return buffer(counted);
}

export { BodyTooLargeError, readCapped };
