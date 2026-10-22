import type { McpServerConfig } from '../agent/AgentRunner.ts';

// The Codex release this code was checked against. The app-server protocol is marked experimental, so an upgrade must
// pass the canary test first (codexCanary.test.ts).
const CODEX_VERSION = '0.163.0';

// "untrusted" asks before every command. "on-request" is not a gate: in the provider spike on issue #128 only 1 of 14
// commands asked with it.
const CODEX_APPROVAL_POLICY = 'untrusted';
const CODEX_SANDBOX = 'workspace-write';
// Every MCP tool asks through mcpServer/elicitation/request, also one that claims readOnlyHint. Without it such a tool
// runs with no question (probed with codex-cli 0.163.0).
const MCP_APPROVAL_MODE = 'prompt';

// Built-in tools that have no approval request. Turned off, they are not offered to the model at all. Probed with
// codex-cli 0.163.0: the model request then lists only exec_command, write_stdin and request_user_input.
const CODEX_GATED_CONFIG: Readonly<Record<string, string | boolean>> = {
    'web_search': 'disabled',
    'features.view_image': false,
    'features.multi_agent': false,
    'features.goals': false,
};

interface CodexThreadStart {
    cwd: string;
    approvalPolicy: typeof CODEX_APPROVAL_POLICY;
    sandbox: typeof CODEX_SANDBOX;
    config: Record<string, unknown>;
}

// Each MCP server of the turn gets the prompt mode. A server config cannot turn the mode off, because it is set last.
function gatedMcpServers(servers: Record<string, McpServerConfig>): Record<string, Record<string, unknown>> {
    const entries = Object.entries(servers)
        .map(([name, server]) => [name, { ...server, default_tools_approval_mode: MCP_APPROVAL_MODE }] as const);

    return Object.fromEntries(entries);
}

// The thread/start params of a CloudBot turn. Every tool the model can reach then asks the client first.
function buildCodexThreadStart(cwd: string, mcpServers: Record<string, McpServerConfig> = {}): CodexThreadStart {
    const servers = gatedMcpServers(mcpServers);
    const serverConfig = Object.keys(servers).length === 0 ? {} : { mcp_servers: servers };

    return {
        cwd,
        approvalPolicy: CODEX_APPROVAL_POLICY,
        sandbox: CODEX_SANDBOX,
        config: { ...CODEX_GATED_CONFIG, ...serverConfig },
    };
}

export { CODEX_GATED_CONFIG, CODEX_VERSION, MCP_APPROVAL_MODE, buildCodexThreadStart };
export type { CodexThreadStart };
