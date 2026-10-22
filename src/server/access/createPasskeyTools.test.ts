import { describe, expect, it, vi } from 'vitest';

import { createPasskeyTools } from './createPasskeyTools.ts';
import type { PasskeySummary } from './PasskeyService.ts';

const LAPTOP: PasskeySummary = { id: 'pk-1', name: 'Laptop', createdAt: 0, lastUsedAt: null };

function makeTools(passkeys: PasskeySummary[]): { tools: ReturnType<typeof createPasskeyTools>; postAddCard: ReturnType<typeof vi.fn>; postRemoveCard: ReturnType<typeof vi.fn> } {
    const postAddCard = vi.fn(() => Promise.resolve());
    const postRemoveCard = vi.fn(() => Promise.resolve());
    const tools = createPasskeyTools({ list: () => Promise.resolve(passkeys), postAddCard, postRemoveCard });

    return { tools, postAddCard, postRemoveCard };
}

function findTool(tools: ReturnType<typeof createPasskeyTools>, name: string): ReturnType<typeof createPasskeyTools>[number] {
    const found = tools.find(candidate => candidate.name === name);

    if (found === undefined) {
        throw new Error(`No tool ${name}`);
    }

    return found;
}

describe('createPasskeyTools', () => {
    it('posts the add card and lists the passkeys', async () => {
        const { tools, postAddCard } = makeTools([LAPTOP]);

        await findTool(tools, 'passkey_add')
            .handler({}, {});
        const listed = await findTool(tools, 'passkey_list')
            .handler({}, {});

        expect(postAddCard)
            .toHaveBeenCalledOnce();
        expect(JSON.stringify(listed))
            .toContain('pk-1');
    });

    it('posts the remove card only for a passkey that exists', async () => {
        const { tools, postRemoveCard } = makeTools([LAPTOP]);
        const removeTool = findTool(tools, 'passkey_remove');

        const missing = await removeTool.handler({ id: 'nope' }, {});

        await removeTool.handler({ id: 'pk-1' }, {});

        expect(missing.isError)
            .toBe(true);
        expect(postRemoveCard)
            .toHaveBeenCalledWith(LAPTOP);
    });
});
