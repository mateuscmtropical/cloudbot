interface ImageSize {
    width: number;
    height: number;
}

const PNG_HEADER_LENGTH = 33;
const PNG_END_CHUNK = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
const GIF_HEADER_LENGTH = 13;
const GIF_TRAILER = 0x3B;
const WEBP_HEADER_LENGTH = 30;
const JPEG_NON_FRAME_MARKERS = new Set([0xC4, 0xC8, 0xCC]);

function readPngSize(bytes: Buffer): ImageSize | undefined {
    const chunkType = bytes.toString('latin1', 12, 16);
    const endChunk = bytes.subarray(bytes.length - PNG_END_CHUNK.length);

    // The first chunk must be IHDR and the last one IEND, or the file was cut short.
    if (bytes.length < PNG_HEADER_LENGTH + PNG_END_CHUNK.length || chunkType !== 'IHDR' || !endChunk.equals(PNG_END_CHUNK)) {
        return undefined;
    }

    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Finds the frame header by walking the marker segments, one recursion per segment.
function findJpegFrame(bytes: Buffer, offset: number, end: number): ImageSize | undefined {
    if (offset + 4 > end || bytes[offset] !== 0xFF) {
        return undefined;
    }

    const marker = bytes[offset + 1] ?? 0;

    if (marker === 0xFF) {
        return findJpegFrame(bytes, offset + 1, end);
    }

    const isFrameHeader = marker >= 0xC0 && marker <= 0xCF && !JPEG_NON_FRAME_MARKERS.has(marker);

    if (isFrameHeader) {
        return offset + 9 <= end
            ? { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
            : undefined;
    }

    return findJpegFrame(bytes, offset + 2 + bytes.readUInt16BE(offset + 2), end);
}

// The file must end with the end-of-image marker. Zero padding after it is allowed.
function readJpegSize(bytes: Buffer): ImageSize | undefined {
    const end = bytes.findLastIndex(byte => byte !== 0x00) + 1;

    if (bytes[end - 2] !== 0xFF || bytes[end - 1] !== 0xD9) {
        return undefined;
    }

    return findJpegFrame(bytes, 2, end);
}

function readGifSize(bytes: Buffer): ImageSize | undefined {
    if (bytes.length < GIF_HEADER_LENGTH + 1 || bytes[bytes.length - 1] !== GIF_TRAILER) {
        return undefined;
    }

    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function readWebpSize(bytes: Buffer): ImageSize | undefined {
    // The RIFF size counts every byte after its own field, so a shorter file was cut short.
    if (bytes.length < WEBP_HEADER_LENGTH || bytes.readUInt32LE(4) + 8 > bytes.length) {
        return undefined;
    }

    const format = bytes.toString('latin1', 12, 16);

    if (format === 'VP8X') {
        return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }

    if (format === 'VP8L' && bytes[20] === 0x2F) {
        const packedSize = bytes.readUInt32LE(21);

        return { width: 1 + (packedSize & 0x3FFF), height: 1 + ((packedSize >>> 14) & 0x3FFF) };
    }

    if (format === 'VP8 ' && bytes[23] === 0x9D && bytes[24] === 0x01 && bytes[25] === 0x2A) {
        return { width: bytes.readUInt16LE(26) & 0x3FFF, height: bytes.readUInt16LE(28) & 0x3FFF };
    }

    return undefined;
}

// Reads the pixel size from the file header and checks that the file is whole.
// Returns undefined when the bytes are not a complete image of the given type.
// This does not decode the pixels. A file that passes can still fail to decode.
function readImageSize(bytes: Buffer, mimeType: string): ImageSize | undefined {
    if (mimeType === 'image/png') {
        return readPngSize(bytes);
    }

    if (mimeType === 'image/jpeg') {
        return readJpegSize(bytes);
    }

    if (mimeType === 'image/gif') {
        return readGifSize(bytes);
    }

    if (mimeType === 'image/webp') {
        return readWebpSize(bytes);
    }

    return undefined;
}

export { readImageSize };
export type { ImageSize };
