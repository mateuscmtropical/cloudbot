import { randomBytes } from 'node:crypto';

import { maskSensitiveNumbers } from '../sensitive/sensitiveNumbers.ts';
import type { CdpConnection } from './CdpConnection.ts';

// One thing the owner did on the screen while it was recorded.
type RecordedStep
    = | { kind: 'open'; url: string }
        | { kind: 'click'; target: string }
        | { kind: 'type'; field: string; text: string }
        // A password or another secret field. Its value is never recorded, only which field it was.
        | { kind: 'secret'; field: string }
        | { kind: 'submit'; target: string };

const MAX_STEPS = 200;
const MAX_TEXT_LENGTH = 200;
const MAX_LABEL_LENGTH = 80;

// Runs in every page while the recording is on. It reports clicks, changed fields and form submits through the binding.
// The value of a field that looks secret never leaves the page: the type, the autocomplete hint and the field names
// decide. The page itself can call the binding too, so a recorded step is a claim of the page, never proof.
function buildRecorderScript(bindingName: string): string {
    return `(() => {
    const report = window[${JSON.stringify(bindingName)}];
    const flagName = ${JSON.stringify(`${bindingName}_on`)};
    if (typeof report !== 'function' || window[flagName] === true) { return; }
    window[flagName] = true;
    const SECRET_WORDS = /pass|pwd|secret|token|otp|one-time|code|cvc|cvv|card|cc-|pin|security|senha|codigo|código|cartao|cartão|cpf/i;
    const short = (text) => String(text || '').replace(/\\s+/g, ' ').trim().slice(0, ${String(MAX_LABEL_LENGTH)});
    const labelOf = (element) => {
        if (!element || element.nodeType !== 1) { return ''; }
        const labelled = element.labels && element.labels[0] ? element.labels[0].innerText : '';
        // A field's value is never a label: it could be the password or code that was just typed. A submit or button
        // input shows its value as its caption, so that value is the label.
        const inputType = String(element.type || '').toLowerCase();
        const isButtonInput = element.tagName === 'INPUT' && (inputType === 'submit' || inputType === 'button');
        const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) && !isButtonInput;
        const text = isButtonInput ? element.value : (isField ? '' : element.innerText);
        return short(element.getAttribute('aria-label') || labelled || element.getAttribute('placeholder')
            || element.getAttribute('name') || element.getAttribute('title') || text
            || element.getAttribute('id') || element.tagName.toLowerCase());
    };
    const isSecretField = (element) => {
        const type = String(element.type || '').toLowerCase();
        const hints = [element.getAttribute('autocomplete'), element.getAttribute('name'), element.getAttribute('id'),
            element.getAttribute('aria-label'), element.getAttribute('placeholder')].join(' ');
        return type === 'password' || type === 'hidden' || SECRET_WORDS.test(hints);
    };
    const send = (step) => { try { report(JSON.stringify(step)); } catch (error) { /* The recording ended. */ } };
    document.addEventListener('click', (event) => {
        const target = event.target && event.target.closest ? event.target.closest('a,button,input,select,textarea,label,[role],[onclick]') || event.target : event.target;
        send({ kind: 'click', target: labelOf(target) });
    }, true);
    document.addEventListener('change', (event) => {
        const field = event.target;
        if (!field || !('value' in field)) { return; }
        if (isSecretField(field)) { send({ kind: 'secret', field: labelOf(field) }); return; }
        send({ kind: 'type', field: labelOf(field), text: String(field.value).slice(0, ${String(MAX_TEXT_LENGTH)}) });
    }, true);
    document.addEventListener('submit', (event) => { send({ kind: 'submit', target: labelOf(event.target) }); }, true);
})();`;
}

// Labels are page text too, so a card, CPF or SSN number shown on a button or a field label is masked as well.
function readLabel(record: Record<string, unknown>, key: string): string {
    const label = readString(record, key, MAX_LABEL_LENGTH);

    return maskSensitiveNumbers(label);
}

function readString(record: Record<string, unknown>, key: string, maxLength: number): string {
    const value = record[key];

    if (typeof value !== 'string') {
        return '';
    }

    const text = value.replace(/\s+/g, ' ')
        .trim();

    return text.slice(0, maxLength);
}

// A step from the page is checked like any outside data. Unknown kinds are dropped, and every text is cut and masked.
function parseStep(payload: string): RecordedStep | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(payload);
    } catch {
        return undefined;
    }

    if (parsed === null || typeof parsed !== 'object') {
        return undefined;
    }

    const record = parsed as Record<string, unknown>;

    switch (record.kind) {
        case 'click':
            return { kind: 'click', target: readLabel(record, 'target') };
        case 'submit':
            return { kind: 'submit', target: readLabel(record, 'target') };
        case 'secret':
            return { kind: 'secret', field: readLabel(record, 'field') };
        case 'type': {
            const text = readString(record, 'text', MAX_TEXT_LENGTH);

            // A card, CPF or SSN number typed into a plain field is masked, as in the chat.
            return { kind: 'type', field: readLabel(record, 'field'), text: maskSensitiveNumbers(text) };
        }
        default:
            return undefined;
    }
}

function readMainFrameUrl(params: unknown): string | undefined {
    const frame: unknown = typeof params === 'object' && params !== null ? Reflect.get(params, 'frame') : undefined;
    const parentId: unknown = typeof frame === 'object' && frame !== null ? Reflect.get(frame, 'parentId') : undefined;
    const url: unknown = typeof frame === 'object' && frame !== null ? Reflect.get(frame, 'url') : undefined;

    return parentId === undefined && typeof url === 'string' ? url : undefined;
}

// The address without its query and fragment, which often hold tokens or personal data.
function plainAddress(url: string): string | undefined {
    try {
        const parsed = new URL(url);

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return undefined;
        }

        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return undefined;
    }
}

// Records what the owner does in the bot's browser through one page connection, until stop() is called.
class ScreenRecorder {
    private readonly page: CdpConnection;
    private readonly bindingName: string;
    private readonly steps: RecordedStep[] = [];
    private isStopped = false;

    private constructor(page: CdpConnection, bindingName: string) {
        this.page = page;
        this.bindingName = bindingName;
    }

    // Opens the recording on a page connection the recorder owns from now on. stop() closes it.
    static async start(page: CdpConnection): Promise<ScreenRecorder> {
        const bindingName = `cloudbotRecord_${randomBytes(8)
            .toString('hex')}`;
        const recorder = new ScreenRecorder(page, bindingName);
        const script = buildRecorderScript(bindingName);

        page.onEvent((method, params) => {
            recorder.handleEvent(method, params);
        });

        try {
            await page.call('Runtime.enable');
            await page.call('Page.enable');
            await page.call('Runtime.addBinding', { name: bindingName });
            await page.call('Page.addScriptToEvaluateOnNewDocument', { source: script });
            await page.call('Runtime.evaluate', { expression: script });
        } catch (error: unknown) {
            page.close();
            throw error;
        }

        return recorder;
    }

    // Ends the recording and returns its steps. The recorder script stays in the open page until it loads again, but
    // the binding is gone with the connection, so nothing more is reported.
    stop(): RecordedStep[] {
        if (!this.isStopped) {
            this.isStopped = true;
            this.page.close();
        }

        return [...this.steps];
    }

    private handleEvent(method: string, params: unknown): void {
        if (this.isStopped || this.steps.length >= MAX_STEPS) {
            return;
        }

        if (method === 'Page.frameNavigated') {
            const frameUrl = readMainFrameUrl(params);
            const url = frameUrl === undefined ? undefined : plainAddress(frameUrl);

            if (url !== undefined) {
                this.steps.push({ kind: 'open', url });
            }

            return;
        }

        if (method !== 'Runtime.bindingCalled' || typeof params !== 'object' || params === null) {
            return;
        }

        const name: unknown = Reflect.get(params, 'name');
        const payload: unknown = Reflect.get(params, 'payload');
        const step = name === this.bindingName && typeof payload === 'string' ? parseStep(payload) : undefined;

        if (step !== undefined) {
            this.steps.push(step);
        }
    }
}

// The steps as text for the bot. The labels and typed text come from web pages, so they are quoted data.
function describeRecordedSteps(steps: RecordedStep[]): string {
    if (steps.length === 0) {
        return 'Nothing was recorded.';
    }

    const lines = steps.map((step, index) => {
        const number = `${String(index + 1)}.`;

        switch (step.kind) {
            case 'open':
                return `${number} Opened ${JSON.stringify(step.url)}`;
            case 'click':
                return `${number} Clicked ${JSON.stringify(step.target)}`;
            case 'type':
                return `${number} Typed ${JSON.stringify(step.text)} into ${JSON.stringify(step.field)}`;
            case 'secret':
                return `${number} Typed a secret into ${JSON.stringify(step.field)} (not recorded, ask for the saved secret)`;
            case 'submit':
                return `${number} Submitted ${JSON.stringify(step.target)}`;
        }
    });

    return lines.join('\n');
}

export { MAX_STEPS, ScreenRecorder, buildRecorderScript, describeRecordedSteps };
export type { RecordedStep };
