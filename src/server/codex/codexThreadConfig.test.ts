import { describe, expect, it } from 'vitest';

import { buildCodexThreadStart } from './codexThreadConfig.ts';

describe('buildCodexThreadStart', () => {
    it('asks before every command and turns off the built-ins that have no approval request', () => {
        expect(buildCodexThreadStart('/work'))
            .toEqual({
                cwd: '/work',
                approvalPolicy: 'untrusted',
                sandbox: 'workspace-write',
                config: {
                    'web_search': 'disabled',
                    'features.view_image': false,
                    'features.multi_agent': false,
                    'features.goals': false,
                },
            });
    });

    it('sets the prompt mode on every MCP server last, so a server config cannot turn it off', () => {
        const start = buildCodexThreadStart('/work', {
            linear: { type: 'http', url: 'https://mcp.example.test' },
            local: { command: 'node', args: ['server.js'] },
        });

        expect(start.config.mcp_servers)
            .toEqual({
                linear: { type: 'http', url: 'https://mcp.example.test', default_tools_approval_mode: 'prompt' },
                local: { command: 'node', args: ['server.js'], default_tools_approval_mode: 'prompt' },
            });
    });
});
