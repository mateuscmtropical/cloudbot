// Runs in the page's own world. The ready state of the document: loading, interactive or complete.
function pageReadyState(): string {
    return document.readyState;
}

export { pageReadyState };
