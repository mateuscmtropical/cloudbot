// Runs in the page's own world. Selects the text of the focused field, so that typing replaces it.
// False when no text field has the focus.
function pageSelectFocusedText(): boolean {
    const field = document.activeElement;

    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        field.select();

        return true;
    }

    return false;
}

export { pageSelectFocusedText };
