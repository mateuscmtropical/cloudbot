import { Readable } from 'node:stream';

interface MultipartFile {
    name: string;
    bytes: Buffer;
}

interface MultipartUpload {
    contentType: string;
    body: Readable;
}

// Builds a multipart body the way a browser sends a file form, for tests.
async function buildMultipartUpload(files: MultipartFile[]): Promise<MultipartUpload> {
    const form = new FormData();

    files.forEach((file) => {
        form.append('files', new File([file.bytes], file.name));
    });

    const response = new Response(form);
    const contentType = response.headers.get('content-type') ?? '';
    const bodyBytes = Buffer.from(await response.arrayBuffer());

    return { contentType, body: Readable.from([bodyBytes]) };
}

export { buildMultipartUpload };
export type { MultipartFile, MultipartUpload };
