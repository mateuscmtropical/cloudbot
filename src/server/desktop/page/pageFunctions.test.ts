/* eslint-disable @typescript-eslint/no-implied-eval -- the browser also rebuilds a page function from its source text */
import { describe, expect, it } from 'vitest';

import { pageActiveElement } from './pageActiveElement.ts';
import { pageClickFocus } from './pageClickFocus.ts';
import { pageClickableElements } from './pageClickableElements.ts';
import { pageDescribeElements } from './pageDescribeElements.ts';
import { pageElementAtPoint } from './pageElementAtPoint.ts';
import { pageFocusCheck } from './pageFocusCheck.ts';
import { pageOrigin, pageUrl } from './pageLocation.ts';
import { pageReadyState } from './pageReadyState.ts';
import { pageSnapshot } from './pageSnapshot.ts';
import { pageStartMeetingRecording, pageTakeMeetingRecording } from './pageMeetingRecording.ts';
import { pageRecordSteps } from './pageRecordSteps.ts';

// Rebuilds a page function from its source with the given globals in scope, as the browser would run it.
function runSource(source: string, globals: Record<string, unknown>): unknown {
    const names = Object.keys(globals);
    const values = Object.values(globals);
    const factory = new Function(...names, `return (${source})();`) as (...args: unknown[]) => unknown;

    return factory(...values);
}

describe('page functions', () => {
    it('is sent as source that compiles on its own, with no names from the server', () => {
        const sources = [pageSnapshot, pageReadyState, pageFocusCheck, pageClickFocus, pageOrigin, pageUrl, pageActiveElement,
            pageElementAtPoint, pageClickableElements, pageDescribeElements, pageStartMeetingRecording, pageTakeMeetingRecording, pageRecordSteps]
            .map(pageFunction => pageFunction.toString());

        sources.forEach((source) => {
            expect(() => new Function(`return (${source});`))
                .not.toThrow();
        });
    });

    it('reads the ready state and the title, address and text of the page it runs in', () => {
        const document = { readyState: 'complete', title: 'Shop', body: { innerText: 'Hello' } };
        const location = { href: 'https://shop.example/', origin: 'https://shop.example' };

        expect(runSource(pageReadyState.toString(), { document }))
            .toBe('complete');
        expect(runSource(pageSnapshot.toString(), { document, location }))
            .toEqual({ title: 'Shop', url: 'https://shop.example/', text: 'Hello' });
    });
});
