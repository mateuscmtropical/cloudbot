// Small whole images for tests. The pixel data is not real, only the headers and the endings are.

function buildPng(width: number, height: number): Buffer {
    const header = Buffer.alloc(33);

    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        .copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'latin1');
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);

    const endChunk = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);

    return Buffer.concat([header, endChunk]);
}

function buildJpeg(width: number, height: number): Buffer {
    const frame = Buffer.alloc(19);

    frame.writeUInt16BE(0xFFC0, 0);
    frame.writeUInt16BE(17, 2);
    frame[4] = 8;
    frame.writeUInt16BE(height, 5);
    frame.writeUInt16BE(width, 7);
    frame[9] = 3;

    return Buffer.concat([Buffer.from([0xFF, 0xD8]), frame, Buffer.from([0xFF, 0xD9])]);
}

function buildGif(width: number, height: number): Buffer {
    const header = Buffer.alloc(13);

    header.write('GIF89a', 0, 'latin1');
    header.writeUInt16LE(width, 6);
    header.writeUInt16LE(height, 8);

    return Buffer.concat([header, Buffer.from([0x3B])]);
}

function buildWebp(width: number, height: number): Buffer {
    const file = Buffer.alloc(30);

    file.write('RIFF', 0, 'latin1');
    file.writeUInt32LE(22, 4);
    file.write('WEBP', 8, 'latin1');
    file.write('VP8X', 12, 'latin1');
    file.writeUInt32LE(10, 16);
    file.writeUIntLE(width - 1, 24, 3);
    file.writeUIntLE(height - 1, 27, 3);

    return file;
}

export { buildGif, buildJpeg, buildPng, buildWebp };
