interface ElementDescription {
    role: string;
    name: string;
}

// Runs in an isolated world. Called on a list of elements, it describes each one. Called on one element, it describes
// the clickable element around it, such as the button around a clicked label. Null when there is none.
function pageDescribeElements(this: Element | Element[], selector: string): ElementDescription[] | ElementDescription | null {
    const inputRoles: Record<string, string> = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox' };
    const tagRoles: Record<string, string> = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' };
    const roleOf = (element: Element): string => {
        const inputRole = element.tagName === 'INPUT' ? inputRoles[(element as HTMLInputElement).type] || 'textbox' : undefined;

        return element.getAttribute('role') || inputRole || tagRoles[element.tagName] || (((element as HTMLElement).isContentEditable) ? 'textbox' : element.tagName.toLowerCase());
    };
    const textOf = (id: string): string => {
        const labelElement = document.getElementById(id);

        return labelElement ? labelElement.innerText : '';
    };
    // The name never reads the value of a field, so a typed password is never listed. Only a button input's value is its label.
    const nameOf = (element: Element): string => {
        const field = element as HTMLInputElement;
        const isField = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT';
        const isButtonInput = element.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(field.type);
        const labelIds = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
            .filter(Boolean);
        const labelledBy = labelIds.map(textOf)
            .join(' ');
        const firstLabel = field.labels ? field.labels[0] : undefined;
        const label = firstLabel ? firstLabel.innerText : '';
        const imageNames = [...element.querySelectorAll('img[alt], [aria-label]')].map(image => image.getAttribute('alt') || image.getAttribute('aria-label') || '');
        const imageName = imageNames.find(text => text.trim() !== '') || '';
        const candidates = [element.getAttribute('aria-label'), labelledBy, label, isField ? '' : (element as HTMLElement).innerText, isButtonInput ? field.value : '', element.getAttribute('placeholder'), element.getAttribute('title'), element.getAttribute('alt'), imageName];

        return candidates.map(text => (text || '').trim())
            .find(text => text !== '') || '';
    };
    const describe = (element: Element): ElementDescription => ({ role: roleOf(element), name: nameOf(element) });

    if (Array.isArray(this)) {
        return this.map(describe);
    }

    const holder = typeof this.closest === 'function' ? this.closest(selector) : null;

    return holder ? describe(holder) : null;
}

export { pageDescribeElements };
export type { ElementDescription };
