// Runs in an isolated world. The element under a point, returned as an object the caller can name.
function pageElementAtPoint(pointX: number, pointY: number): Element | null {
    return document.elementFromPoint(pointX, pointY);
}

export { pageElementAtPoint };
