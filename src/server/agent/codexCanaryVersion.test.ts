import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CODEX_PROTOCOL_VERSION } from './codexProtocol.ts';

const CI_PATH = new URL('../../../.github/workflows/ci.yml', import.meta.url);

describe('the Codex canary in CI', () => {
    it('installs the Codex version the engine was checked against', () => {
        const workflow = readFileSync(CI_PATH, 'utf8');
        const installed = [...workflow.matchAll(/@openai\/codex@(\S+)/g)].map(match => match[1]);

        expect(installed)
            .toEqual([CODEX_PROTOCOL_VERSION]);
        expect(workflow)
            .toContain('pnpm canary:codex');
    });
});
