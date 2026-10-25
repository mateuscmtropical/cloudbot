// A phone photo can be several MB and larger than a model takes. Before the upload, a big photo is drawn smaller in
// the browser and saved as JPEG, so it stays far below the 5 MB image limit of the server. GIFs keep their frames.
const COMPRESSED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_SIDE_PIXELS = 2048;
const MAX_KEPT_BYTES = 1_500_000;
const JPEG_QUALITY = 0.85;

interface ScaledSize {
    width: number;
    height: number;
}

function scaleToFit(width: number, height: number): ScaledSize {
    const scale = Math.min(1, MAX_SIDE_PIXELS / Math.max(width, height));

    return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function drawAsJpeg(bitmap: ImageBitmap, size: ScaledSize): Promise<Blob | null> {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    canvas.width = size.width;
    canvas.height = size.height;

    if (context === null) {
        return Promise.resolve(null);
    }

    // JPEG has no transparency, so a clear pixel turns white instead of black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);

    return new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
    });
}

// Returns the file itself when it is small enough, not a still image, or when the browser cannot draw it.
async function compressImage(file: File): Promise<File> {
    if (!COMPRESSED_TYPES.has(file.type)) {
        return file;
    }

    try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const size = scaleToFit(bitmap.width, bitmap.height);
        const isSmallEnough = size.width === bitmap.width && file.size <= MAX_KEPT_BYTES;

        if (isSmallEnough) {
            bitmap.close();

            return file;
        }

        const blob = await drawAsJpeg(bitmap, size);

        bitmap.close();

        if (blob === null || blob.size >= file.size) {
            return file;
        }

        const baseName = file.name.replace(/\.[^.]*$/, '');

        return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
    } catch {
        return file;
    }
}

export { compressImage, scaleToFit };
