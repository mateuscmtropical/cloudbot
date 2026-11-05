// Runs in every page while the recording is on. It reports clicks, changed fields and form submits through the binding.
// The value of a field that looks secret never leaves the page: the type, the autocomplete hint and the field names
// decide. The page itself can call the binding too, so a recorded step is a claim of the page, never proof.
// The limits come from the caller, so the server keeps the one copy of each.
function pageRecordSteps(bindingName: string, maxLabelLength: number, maxTextLength: number): void {
    const scope = window as unknown as Record<string, unknown>;
    const report = scope[bindingName] as ((payload: string) => void) | undefined;
    const flagName = `${bindingName}_on`;

    if (typeof report !== 'function' || scope[flagName] === true) {
        return;
    }

    scope[flagName] = true;

    const SECRET_WORDS = /pass|pwd|secret|token|otp|one-time|code|cvc|cvv|card|cc-|pin|security|senha|codigo|código|cartao|cartão|cpf/i;
    const short = (text: string | null | undefined): string => (text || '').replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLabelLength);
    // A field's value is never a label: it could be the password or code that was just typed. A submit or button
    // input shows its value as its caption, so that value is the label.
    const labelOf = (element: Element | null): string => {
        if (!element || element.nodeType !== 1) {
            return '';
        }

        const field = element as HTMLInputElement;
        const firstLabel = field.labels ? field.labels[0] : undefined;
        const labelled = firstLabel ? firstLabel.innerText : '';
        const inputType = (field.type || '').toLowerCase();
        const isButtonInput = element.tagName === 'INPUT' && (inputType === 'submit' || inputType === 'button');
        const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) && !isButtonInput;
        const text = isButtonInput ? field.value : (isField ? '' : (element as HTMLElement).innerText);

        return short(element.getAttribute('aria-label') || labelled || element.getAttribute('placeholder')
            || element.getAttribute('name') || element.getAttribute('title') || text
            || element.getAttribute('id') || element.tagName.toLowerCase());
    };
    const isSecretField = (element: Element): boolean => {
        const field = element as HTMLInputElement;
        const type = (field.type || '').toLowerCase();
        const hints = [element.getAttribute('autocomplete'), element.getAttribute('name'), element.getAttribute('id'),
            element.getAttribute('aria-label'), element.getAttribute('placeholder')].join(' ');

        return type === 'password' || type === 'hidden' || SECRET_WORDS.test(hints);
    };
    const send = (step: object): void => {
        const payload = JSON.stringify(step);

        try {
            report(payload);
        } catch {
            // The recording ended.
        }
    };

    document.addEventListener('click', (event) => {
        const source = event.target;
        const element = source instanceof Element ? source : null;
        const clicked = element === null ? null : element.closest('a,button,input,select,textarea,label,[role],[onclick]') ?? element;

        send({ kind: 'click', target: labelOf(clicked) });
    }, true);
    document.addEventListener('change', (event) => {
        const field = event.target as HTMLInputElement | null;

        if (!field || !('value' in field)) {
            return;
        }

        if (isSecretField(field)) {
            send({ kind: 'secret', field: labelOf(field) });

            return;
        }

        send({ kind: 'type', field: labelOf(field), text: field.value.slice(0, maxTextLength) });
    }, true);
    document.addEventListener('submit', (event) => {
        send({ kind: 'submit', target: labelOf(event.target as Element | null) });
    }, true);
}

export { pageRecordSteps };
