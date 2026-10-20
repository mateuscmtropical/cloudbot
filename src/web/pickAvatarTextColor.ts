const DARK_TEXT = '#111114';
const LIGHT_TEXT = '#ffffff';
const HEX_COLOR_PATTERN = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
// Above this relative luminance white text loses contrast, so dark text is used.
const LIGHT_BACKGROUND_LUMINANCE = 0.5;

function toLinearChannel(hexPair: string): number {
    const channel = Number.parseInt(hexPair, 16) / 255;

    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function pickAvatarTextColor(backgroundColor: string): string {
    const match = HEX_COLOR_PATTERN.exec(backgroundColor);

    if (match === null) {
        return LIGHT_TEXT;
    }

    const [, redPair = '00', greenPair = '00', bluePair = '00'] = match;
    const red = toLinearChannel(redPair);
    const green = toLinearChannel(greenPair);
    const blue = toLinearChannel(bluePair);
    const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);

    return luminance > LIGHT_BACKGROUND_LUMINANCE ? DARK_TEXT : LIGHT_TEXT;
}

export { pickAvatarTextColor };
