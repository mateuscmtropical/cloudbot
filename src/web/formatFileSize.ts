const BYTES_PER_KILOBYTE = 1024;
const UNITS = ['KB', 'MB', 'GB'];
const DECIMALS_BELOW = 10;

function formatUnit(value: number, unitIndex: number): string {
    const isLastUnit = unitIndex >= UNITS.length - 1;

    if (value >= BYTES_PER_KILOBYTE && !isLastUnit) {
        const nextValue = value / BYTES_PER_KILOBYTE;

        return formatUnit(nextValue, unitIndex + 1);
    }

    // One decimal above 10 units would be noise, so it is shown only below 10.
    const wholeValue = Math.round(value);
    const rounded = value < DECIMALS_BELOW ? value.toFixed(1) : String(wholeValue);
    const unit = UNITS[unitIndex] ?? 'GB';

    return `${rounded} ${unit}`;
}

function formatFileSize(sizeBytes: number): string {
    if (sizeBytes < BYTES_PER_KILOBYTE) {
        return `${String(sizeBytes)} B`;
    }

    return formatUnit(sizeBytes / BYTES_PER_KILOBYTE, 0);
}

export { formatFileSize };
