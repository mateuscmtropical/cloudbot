// Claude Code names the folder of a project under ~/.claude/projects after the project path. Every character that
// is not a letter or a digit becomes a dash, so "/var/lib/cloudbot-workspaces/bot_1" is "-var-lib-cloudbot-workspaces-bot-1".
function encodeProjectPath(projectPath: string): string {
    return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

export { encodeProjectPath };
