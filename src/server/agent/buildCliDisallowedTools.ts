const CLI_DISALLOWED_TOOLS = [
    // CloudBot owns routine creation, so the CLI cannot schedule a second routine service.
    'CronCreate',
    // CloudBot owns routine deletion, so CLI cron entries cannot alter its schedules.
    'CronDelete',
    // CloudBot owns routine listings, so CLI cron state is not exposed as a second scheduler.
    'CronList',
    // CloudBot routines stay on the VPS rather than waking an Anthropic cloud agent.
    'ScheduleWakeup',
    // A trigger must start CloudBot routines on the VPS, not an Anthropic cloud agent.
    'RemoteTrigger',
    // CloudBot's notification tool keeps browser opt-in and owner review in the server.
    'PushNotification',
    // CloudBot chats are the only bot-to-bot messaging surface.
    'SendMessage',
    // CloudBot helpers are configured per bot, so the CLI agent list is unrelated state.
    'ListAgents',
    // CloudBot routines are the only workflow system exposed to bots.
    'Workflow',
    // CloudBot's queue and turn controls own monitoring of bot work.
    'Monitor',
    // Each bot has a CloudBot workspace, not a CLI-managed worktree.
    'EnterWorktree',
    // Each bot has a CloudBot workspace, not a CLI-managed worktree.
    'ExitWorktree',
    // Design sync belongs to the CLI and bypasses CloudBot's connected app flow.
    'DesignSync',
    // Findings reports use the CLI's reporting path rather than the bot's chat.
    'ReportFindings',
    // CloudBot's helper lifecycle is managed through the server and its queue.
    'TaskStop',
    // CloudBot uses reviewed file tools instead of notebook-specific filesystem access.
    'NotebookEdit',
    // CloudBot runs its configured shell through Bash and its review path.
    'PowerShell',
    // CloudBot does not load CLI skills, so they cannot add a separate execution surface.
    'Skill',
];

function buildCliDisallowedTools(ownerDisallowedTools: string[]): string[] {
    const disallowedTools = [...new Set([...CLI_DISALLOWED_TOOLS, ...ownerDisallowedTools])];

    return disallowedTools;
}

export { buildCliDisallowedTools, CLI_DISALLOWED_TOOLS };
