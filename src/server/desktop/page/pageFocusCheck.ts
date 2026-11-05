interface FocusCheck {
    origin: string;
    tag: string;
    type: string;
    autocomplete: string;
}

// Runs in an isolated world, so the page's own scripts cannot change what it reads. Reads the focused element only.
function pageFocusCheck(): FocusCheck {
    const field = document.activeElement;
    const input = field as HTMLInputElement | null;
    const isInput = input !== null && input.tagName === 'INPUT';
    const autocomplete = isInput ? input.autocomplete : '';
    const tokens = autocomplete.trim()
        .toLowerCase()
        .split(/\s+/);

    return {
        origin: location.origin,
        tag: field ? field.tagName : '',
        type: isInput ? input.type : '',
        autocomplete: tokens.pop() || '',
    };
}

export { pageFocusCheck };
export type { FocusCheck };
