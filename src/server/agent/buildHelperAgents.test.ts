import { describe, expect, it } from 'vitest';

import { BROWSER_TOOL_FULL_NAMES } from '../desktop/createBrowserTools.ts';
import { buildHelperAgents } from './buildHelperAgents.ts';
import { SHARE_FILE_TOOL_FULL_NAME } from './createProfileToolServer.ts';

const NO_HELPERS = { browsing: null, documents: null };
const NO_BLOCKS: string[] = [];

describe('buildHelperAgents', () => {
    it('has no helper when the owner chose no model for any', () => {
        expect(buildHelperAgents(NO_HELPERS, { disallowedTools: NO_BLOCKS, hasBrowser: true }))
            .toEqual({});
    });

    it('gives a browsing helper its own model and only the browser tools', () => {
        const agents = buildHelperAgents({ browsing: 'haiku', documents: null }, { disallowedTools: NO_BLOCKS, hasBrowser: true });

        expect(agents)
            .toMatchObject({
                browsing: {
                    model: 'haiku',
                    tools: BROWSER_TOOL_FULL_NAMES,
                    disallowedTools: NO_BLOCKS,
                },
            });
    });

    it('gives no browsing helper when the bot has no browser', () => {
        const agents = buildHelperAgents({ browsing: 'haiku', documents: null }, { disallowedTools: NO_BLOCKS, hasBrowser: false });

        expect(agents)
            .toEqual({});
    });

    it('gives a documents helper the file tools with share_file', () => {
        const agents = buildHelperAgents({ browsing: null, documents: 'sonnet' }, { disallowedTools: NO_BLOCKS, hasBrowser: false });

        expect(agents.documents?.model)
            .toBe('sonnet');
        expect(agents.documents?.tools)
            .toEqual(expect.arrayContaining(['Bash', 'Read', 'Write', SHARE_FILE_TOOL_FULL_NAME]));
        expect(agents.documents?.tools)
            .not.toContain(BROWSER_TOOL_FULL_NAMES[0]);
    });

    it('passes the owner blocked tools to every helper as disallowedTools', () => {
        const blocked = ['Bash(rm:*)'];
        const agents = buildHelperAgents({ browsing: 'haiku', documents: 'opus' }, { disallowedTools: blocked, hasBrowser: true });

        expect(agents.browsing?.disallowedTools)
            .toEqual(blocked);
        expect(agents.documents?.disallowedTools)
            .toEqual(blocked);
    });
});
