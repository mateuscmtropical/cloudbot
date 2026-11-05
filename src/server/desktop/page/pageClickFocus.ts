interface ClickFocus {
    targetIsTextField: boolean;
    focusedIsField: boolean;
}

// Reads what is under the point and what has the focus. It only reads, so the page cannot be changed by it.
// Only a text field is clicked again, because a second click would toggle a checkbox or press a button twice.
// The focus is followed into shadow roots and same-origin frames. A frame of another site counts as focused.
function pageClickFocus(pointX: number, pointY: number): ClickFocus {
    const nonTextInputTypes = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'color', 'range', 'hidden'];
    const isText = (element: Element | null): boolean => {
        if (element === null) {
            return false;
        }

        const field = element as HTMLInputElement;

        return !field.disabled && !field.readOnly
            && (element.tagName === 'TEXTAREA' || (element.tagName === 'INPUT' && !nonTextInputTypes.includes(field.type)) || (element as HTMLElement).isContentEditable);
    };
    const isField = (element: Element | null): boolean => {
        if (isText(element)) {
            return true;
        }

        return element !== null && !(element as HTMLSelectElement).disabled && element.tagName === 'SELECT';
    };
    // Undefined when the focus is in a frame of another site, which cannot be read.
    const followFocus = (active: Element | null): Element | null | undefined => {
        if (active && active.shadowRoot && active.shadowRoot.activeElement) {
            return followFocus(active.shadowRoot.activeElement);
        }

        if (active && active.tagName === 'IFRAME') {
            const frameDocument = (active as HTMLIFrameElement).contentDocument;

            if (!frameDocument) {
                return undefined;
            }

            if (frameDocument.activeElement) {
                return followFocus(frameDocument.activeElement);
            }
        }

        return active;
    };
    const target = document.elementFromPoint(pointX, pointY);
    const focused = followFocus(document.activeElement);

    return {
        targetIsTextField: isText(target),
        focusedIsField: focused === undefined ? true : isField(focused),
    };
}

export { pageClickFocus };
export type { ClickFocus };
