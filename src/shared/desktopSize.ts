interface DesktopSize {
    width: number;
    height: number;
}

const DEFAULT_DESKTOP_SIZE: DesktopSize = { width: 1280, height: 800 };
const MIN_DESKTOP_DIMENSION = 240;
const MAX_DESKTOP_DIMENSION = 1920;

function isValidDesktopSize(width: number, height: number): boolean {
    const isWidthValid = Number.isInteger(width) && width >= MIN_DESKTOP_DIMENSION && width <= MAX_DESKTOP_DIMENSION;
    const isHeightValid = Number.isInteger(height) && height >= MIN_DESKTOP_DIMENSION && height <= MAX_DESKTOP_DIMENSION;

    return isWidthValid && isHeightValid;
}

export { DEFAULT_DESKTOP_SIZE, MAX_DESKTOP_DIMENSION, MIN_DESKTOP_DIMENSION, isValidDesktopSize };
export type { DesktopSize };
