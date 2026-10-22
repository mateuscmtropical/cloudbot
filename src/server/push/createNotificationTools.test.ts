import { describe, expect, it } from 'vitest';

import { createNotificationsDisableTool, createNotificationsEnableTool } from './createNotificationTools.ts';
import type { NotificationToolResult } from './createNotificationTools.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<NotificationToolResult>;

describe('createNotificationsEnableTool', () => {
    it('posts the card and tells the bot to stop', async () => {
        let postCount = 0;
        const handler = createNotificationsEnableTool(() => {
            postCount += 1;

            return Promise.resolve();
        }).handler as unknown as ToolHandler;
        const result = await handler({}, {});

        expect(postCount)
            .toBe(1);
        expect(result.isError)
            .toBeUndefined();
        expect(result.content[0]?.text)
            .toContain('then stop');
    });

    it('reports an error without the cause when the card cannot be posted', async () => {
        const handler = createNotificationsEnableTool(() => Promise.reject(new Error('disk full'))).handler as unknown as ToolHandler;
        const result = await handler({}, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .not.toContain('disk full');
    });
});

describe('createNotificationsDisableTool', () => {
    it('posts the card and tells the bot to stop', async () => {
        let postCount = 0;
        const handler = createNotificationsDisableTool(() => {
            postCount += 1;

            return Promise.resolve();
        }).handler as unknown as ToolHandler;
        const result = await handler({}, {});

        expect(postCount)
            .toBe(1);
        expect(result.isError)
            .toBeUndefined();
        expect(result.content[0]?.text)
            .toContain('turn off notifications');
    });

    it('reports an error without the cause when the card cannot be posted', async () => {
        const handler = createNotificationsDisableTool(() => Promise.reject(new Error('disk full'))).handler as unknown as ToolHandler;
        const result = await handler({}, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .not.toContain('disk full');
    });
});
