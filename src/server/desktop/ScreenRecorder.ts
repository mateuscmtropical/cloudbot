import { randomBytes } from 'node:crypto';

import { maskSensitiveNumbers } from '../sensitive/sensitiveNumbers.ts';
import type { CdpConnection } from './CdpConnection.ts';
import { evaluateInPage } from './evaluateInPage.ts';
import { pageRecordSteps } from './page/pageRecordSteps.ts';

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

// Page.addScriptToEvaluateOnNewDocument takes text only, so the arguments are written in as literals here.
// The page function itself gets them from its arguments, never from this file.
function buildRecorderScript(bindingName: string): string {
    return `(${pageRecordSteps.toString()})(${JSON.stringify(bindingName)}, ${String(MAX_LABEL_LENGTH)}, ${String(MAX_TEXT_LENGTH)});`;
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
            await evaluateInPage(page, pageRecordSteps, [bindingName, MAX_LABEL_LENGTH, MAX_TEXT_LENGTH]);
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
