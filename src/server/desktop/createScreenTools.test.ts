import { describe, expect, it } from 'vitest';

import { createRequestScreenTool } from './createScreenTools.ts';
import type { ScreenToolResult } from './createScreenTools.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ScreenToolResult>;

describe('createRequestScreenTool', () => {
    it('hands the screen over with the reason and tells the bot to wait', async () => {
        const reasons: string[] = [];
        const handler = createRequestScreenTool((reason) => {
            reasons.push(reason);

            return Promise.resolve();
        }).handler as unknown as ToolHandler;
        const result = await handler({ reason: 'A check on the sign-in page.' }, {});

        expect(reasons)
            .toEqual(['A check on the sign-in page.']);
        expect(result.isError)
            .toBeUndefined();
        expect(result.content[0]?.text)
            .toContain('stop and wait');
    });

    it('reports an error when the handover fails', async () => {
        const handler = createRequestScreenTool(() => Promise.reject(new Error('disk full'))).handler as unknown as ToolHandler;
        const result = await handler({ reason: 'x' }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text).not.toContain('disk full');
    });
});
