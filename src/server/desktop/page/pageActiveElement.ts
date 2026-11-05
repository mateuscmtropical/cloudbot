// Runs in an isolated world. The focused element, returned as an object the caller can name.
function pageActiveElement(): Element | null {
    return document.activeElement;
}

export { pageActiveElement };
