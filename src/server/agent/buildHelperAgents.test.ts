import { describe, expect, it } from 'vitest';

import { BROWSER_TOOL_FULL_NAMES } from '../desktop/createBrowserTools.ts';
import { buildHelperAgents, helperTurnParts } from './buildHelperAgents.ts';
import { CLI_DISALLOWED_TOOLS } from './buildCliDisallowedTools.ts';
import { SHARE_FILE_TOOL_FULL_NAME } from './createProfileToolServer.ts';

const NO_HELPERS = { search: null, browsing: null, documents: null };
const NO_BLOCKS: string[] = [];

describe('buildHelperAgents', () => {
    it('has no helper when the owner chose no model for any', () => {
        expect(buildHelperAgents(NO_HELPERS, { disallowedTools: NO_BLOCKS, hasBrowser: true }))
            .toEqual({});
    });

    it('gives a search helper its own model and only the web tools', () => {
        const agents = buildHelperAgents({ search: 'haiku', browsing: null, documents: null }, { disallowedTools: NO_BLOCKS, hasBrowser: false });

        expect(agents)
            .toMatchObject({
                search: {
                    model: 'haiku',
                    tools: ['WebSearch', 'WebFetch'],
                    disallowedTools: CLI_DISALLOWED_TOOLS,
                },
            });
        expect(agents)
            .not.toHaveProperty('browsing');
    });

    it('gives no search helper when the owner chose no model for search', () => {
        const agents = buildHelperAgents({ search: null, browsing: null, documents: 'sonnet' }, { disallowedTools: NO_BLOCKS, hasBrowser: false });

        expect(agents)
            .not.toHaveProperty('search');
    });

    it('gives a browsing helper its own model and only the browser tools', () => {
        const agents = buildHelperAgents({ search: null, browsing: 'haiku', documents: null }, { disallowedTools: NO_BLOCKS, hasBrowser: true });

        expect(agents)
            .toMatchObject({
                browsing: {
                    model: 'haiku',
                    tools: BROWSER_TOOL_FULL_NAMES,
                    disallowedTools: CLI_DISALLOWED_TOOLS,
                },
            });
    });

    it('gives no browsing helper when the bot has no browser', () => {
        const agents = buildHelperAgents({ search: null, browsing: 'haiku', documents: null }, { disallowedTools: NO_BLOCKS, hasBrowser: false });

        expect(agents)
            .toEqual({});
    });

    it('gives a documents helper the file tools with share_file', () => {
        const agents = buildHelperAgents({ search: null, browsing: null, documents: 'sonnet' }, { disallowedTools: NO_BLOCKS, hasBrowser: false });

        expect(agents.documents?.model)
            .toBe('sonnet');
        expect(agents.documents?.tools)
            .toEqual(expect.arrayContaining(['Bash', 'Read', 'Write', SHARE_FILE_TOOL_FULL_NAME]));
        expect(agents.documents?.tools)
            .not.toContain(BROWSER_TOOL_FULL_NAMES[0]);
    });

    it('gives each helper the effort the owner chose for it', () => {
        const agents = buildHelperAgents(
            { search: 'haiku', browsing: 'haiku', documents: 'sonnet' },
            { disallowedTools: NO_BLOCKS, hasBrowser: true, efforts: { search: 'medium', browsing: 'low', documents: 'xhigh' } },
        );

        expect(agents.search)
            .toHaveProperty('effort', 'medium');
        expect(agents.browsing)
            .toHaveProperty('effort', 'low');
        expect(agents.documents)
            .toHaveProperty('effort', 'xhigh');
    });

    it('leaves the effort off a helper when none is chosen for it', () => {
        const agents = buildHelperAgents(
            { search: 'haiku', browsing: 'haiku', documents: 'sonnet' },
            { disallowedTools: NO_BLOCKS, hasBrowser: true, efforts: { search: null, browsing: null, documents: 'max' } },
        );

        expect(agents.search)
            .not.toHaveProperty('effort');
        expect(agents.browsing)
            .not.toHaveProperty('effort');
        expect(agents.documents)
            .toHaveProperty('effort', 'max');
    });

    it('passes the owner blocked tools to every helper as disallowedTools', () => {
        const blocked = ['Bash(rm:*)'];
        const agents = buildHelperAgents({ search: 'haiku', browsing: 'haiku', documents: 'opus' }, { disallowedTools: blocked, hasBrowser: true });

        expect(agents.search?.disallowedTools)
            .toEqual([...CLI_DISALLOWED_TOOLS, ...blocked]);
        expect(agents.browsing?.disallowedTools)
            .toEqual([...CLI_DISALLOWED_TOOLS, ...blocked]);
        expect(agents.documents?.disallowedTools)
            .toEqual([...CLI_DISALLOWED_TOOLS, ...blocked]);
    });
});

describe('helperTurnParts', () => {
    it('gives a search helper no profile tools and the built in web tools', () => {
        const parts = helperTurnParts('search');

        expect(parts.prompt)
            .toContain('You search the web for the main agent');
        expect(parts.toolNames)
            .toEqual([]);
        expect(parts.builtInToolNames)
            .toEqual(['WebSearch', 'WebFetch']);
    });

    it('gives a browsing helper the browser tools and no built in tools', () => {
        const parts = helperTurnParts('browsing');

        expect(parts.prompt)
            .toContain('You browse websites');
        expect(parts.toolNames)
            .toEqual(BROWSER_TOOL_FULL_NAMES);
        expect(parts.builtInToolNames)
            .toEqual([]);
    });
});
