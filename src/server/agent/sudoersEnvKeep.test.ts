import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The variables the server puts in the agent user's environment. sudo drops every other one, so each must be in env_keep.
// The GitHub names come from githubRouting.ts, the proxy names from the agent spawn, NO_PROXY from ClaudeCliEngine.
const NAMES_THE_SERVER_SETS = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'NO_PROXY',
    'no_proxy',
    'GH_HOST',
    'GH_ENTERPRISE_TOKEN',
    'GH_PROMPT_DISABLED',
    'GH_NO_UPDATE_NOTIFIER',
    'SSL_CERT_FILE',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_KEY_1',
    'GIT_CONFIG_VALUE_1',
    'GIT_CONFIG_KEY_2',
    'GIT_CONFIG_VALUE_2',
    'DISABLE_AUTOUPDATER',
    'CLOUDBOT_TURN_MARKER',
];

const SUDOERS_PATH = new URL('../../../docker/cloudbot-agent.sudoers', import.meta.url);
const DOCKERFILE_PATH = new URL('../../../docker/Dockerfile', import.meta.url);
const CLI_PATH = '/usr/local/bin/claude';

// The env_keep names, one per token. A name glued to the next one (a missing space) fails the pattern.
function keptNames(): string[] {
    const text = readFileSync(SUDOERS_PATH, 'utf8');
    const line = text.split('\n')
        .find(candidate => candidate.startsWith('Defaults:cloudbot env_keep='));
    const quoted = line?.match(/env_keep="([^"]*)"/)?.[1] ?? '';

    return quoted.split(' ')
        .filter(name => name !== '');
}

describe('sudoers env_keep for the agent user', () => {
    it('lists every name the server sets, so sudo does not drop it', () => {
        const kept = keptNames();

        expect(NAMES_THE_SERVER_SETS.filter(name => !kept.includes(name)))
            .toEqual([]);
    });

    it('has one well-formed variable name per token', () => {
        const kept = keptNames();

        expect(kept.filter(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
            .toEqual([]);
        expect(kept)
            .toContain('GH_HOST');
        expect(kept)
            .toContain('GH_ENTERPRISE_TOKEN');
    });

    it('allows the agent user only the signal wrapper for process groups, not kill itself', () => {
        const sudoers = readFileSync(SUDOERS_PATH, 'utf8');

        expect(sudoers)
            .toContain('NOSETENV: /usr/local/bin/cloudbot-signal-group *');
        expect(sudoers)
            .not.toContain('/bin/kill');
    });

    it('lets the agent user run only the root-owned CLI copy, the one CLAUDE_PATH names', () => {
        const sudoers = readFileSync(SUDOERS_PATH, 'utf8');
        const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');

        expect(sudoers)
            .toContain(`cloudbot ALL=(bot) NOPASSWD: NOSETENV: ${CLI_PATH}\n`);
        expect(dockerfile)
            .toContain(`CLAUDE_PATH=${CLI_PATH}`);
    });
});
