import type { ToolCall } from '../agent/AgentRunner.ts';

// A fixed floor of commands the bot never runs. It is checked before the review agent, and no rule, approval
// or model choice can lift it. It is a floor, not a shell parser. It splits a command at separators, reads the
// program at the start of each part, skips simple wrappers and matches a few clear patterns. Commands built at
// run time, such as variables, encoded text or $(...), are not seen. Arguments that xargs builds are not seen,
// and a relative path after a change of folder is not tracked. A quoted mention of a vault file name is refused
// even inside quoted text. The refusal names the kind of command, never the command itself, because a command
// may hold a secret.

const REASON_WIPE = 'The bot never deletes a home folder, the data folder or the root of the disk.';
const REASON_DISK = 'The bot never formats a disk or writes to a disk device.';
const REASON_FORK_BOMB = 'The bot never runs a fork bomb.';
const REASON_SERVICE = 'The bot never stops, disables or edits the cloudbot service.';
const REASON_VAULT = 'The bot never reads or copies the vault files.';
const REASON_UNCHECKED = 'The command could not be checked.';
// A longer command is refused before anything is read, so the checks below only see commands of a sane size.
const MAX_COMMAND_LENGTH = 20000;
const REASON_TOO_LONG = `The bot never runs a command longer than ${String(MAX_COMMAND_LENGTH)} characters.`;

const DATA_FOLDER = '/var/lib/cloudbot';
// Programs that may name the data folder without reading it, such as a listing of the folder.
const DATA_FOLDER_LISTERS = new Set(['ls', 'cd', 'stat', 'du', 'df', 'test', '[', 'mkdir', 'chown', 'chmod', 'tree', 'echo']);
const UNIT_FOLDER = '/etc/systemd/system';
const INIT_SCRIPT = '/etc/init.d/cloudbot';
// Folders a recursive delete must never reach. Targets are normalized first, see normalizeTarget.
const WIPE_TARGETS = new Set(['/', '/*', '/root', '/root/*', '/home', '/home/*', '/home/bot', '/home/bot/*', '~', '~/*', '$HOME', '$HOME/*', DATA_FOLDER, `${DATA_FOLDER}/*`, '/var/lib/cloudbot-workspaces', '/var/lib/cloudbot-workspaces/*', '/var/lib/cloudbot-uploads', '/var/lib/cloudbot-uploads/*']);
const DISK_NODE = '(sd|hd|vd|xvd|nvme|mmcblk|disk|loop|md|dm-|mapper|zd)';
const DISK_DEVICE_PATTERN = new RegExp(`\\/dev\\/${DISK_NODE}`);
const DISK_REDIRECT_PATTERN = new RegExp(`>\\s*\\/dev\\/${DISK_NODE}`);
// Any write into the unit folder, by a redirect such as > /etc/systemd/system/cloudbot.service.
const UNIT_REDIRECT_PATTERN = new RegExp(`>\\s*${UNIT_FOLDER}(?:\\/|\\s|$)`);
// A fork bomb such as :(){ :|:& }: or name(){ name|name& }name, checked without spaces.
const FORK_BOMB_PATTERN = /(\w{1,64}|[:.])\(\)\{\1\|\1&\};?\1/;
// The vault files by name, by a glob or a name that starts with vault. A name such as vault.notes.md is refused
// too, see ARCHITECTURE. The data folder is refused for a vault name, a vault prefix and any glob inside it.
// The push key file sits next to them. It signs every push, so the bot never reads it either.
const VAULT_NAME_PATTERN = /(?:vault\.(?:key|json)|push-vapid\.json)\b/;
const VAULT_GLOB_PATTERN = /(?:vault|push-vapid)[.*?[]/;
const DATA_FOLDER_VAULT_PATTERN = /\/var\/lib\/cloudbot\/(?:vault|push-vapid)/;
const DATA_FOLDER_GLOB_PATTERN = /\/var\/lib\/cloudbot\/[^\s/]{0,255}[*?[]/;
const VAULT_PATTERNS = [VAULT_NAME_PATTERN, VAULT_GLOB_PATTERN, DATA_FOLDER_VAULT_PATTERN, DATA_FOLDER_GLOB_PATTERN];
// A glob of dot files inside a folder, such as $HOME/.* or ~/.[a-z]*. The folder part is the first match group.
const DOT_GLOB_PATTERN = /^(.*)\/\.[*[]/;
const NUMBER_PATTERN = /^\d+(\.\d+)?[smhd]?$/;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_]\w*=/;
// A short option group with c in it, such as -c, -lc or -xc.
const SHELL_C_FLAG_PATTERN = /^-[a-zA-Z]*c[a-zA-Z]*$/;
// sed -i, sed -ni, sed -i.bak and sed --in-place edit the file in place.
const IN_PLACE_FLAG_PATTERN = /^(-[a-zA-Z]*i|--in-place)/;
// Splits a command at the semicolon, the pipes, the ampersands, newlines, brackets and backticks.
const SEPARATOR_PATTERN = /;|&&|\|\||\||&|\n|\(|\)|\{|\}|`/;
const LINE_CONTINUATION_PATTERN = /\\\r?\n/g;
const LINE_BREAK_PATTERN = /\r?\n/g;
// A pipe into a shell. The text before the first such pipe is the input the shell reads.
// The shell may come after sudo, env or a path such as /bin/.
const PIPE_INTO_SHELL_PATTERN = /^(.*?)\|\s*(?:(?:sudo|env)\s+)*(?:[^\s|]*\/)?(?:sh|bash|zsh|dash)(?:\s|$)/;
const HERE_STRING = '<<<';
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash']);
// echo and printf print their arguments, so a shell after them reads those arguments.
const PRINT_PROGRAMS = new Set(['echo', 'printf']);

const WRAPPER_WORDS = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'exec', 'command', 'nice', 'timeout', 'xargs', 'stdbuf', 'ionice', 'busybox', 'setsid', 'chroot']);
// Shell keywords and negation. The command after them is the one that runs.
const KEYWORD_WORDS = new Set(['!', 'if', 'then', 'do', 'else', 'while', 'until']);
// Options whose value is the next word, such as the user of sudo -u bot or the signal of timeout -s KILL.
const OPTIONS_WITH_VALUE = new Set(['-u', '-g', '-U', '-C', '-h', '-p', '-D', '-R', '-s', '-k']);
// Programs whose -c option runs its text as a command. su -c runs the text as the user it switches to.
const PAYLOAD_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'su']);
const UNIT_WRITE_PROGRAMS = new Set(['rm', 'tee', 'truncate', 'chmod', 'chown', 'ln', 'nano', 'vi', 'vim']);
// Copy and move tools, where the last word is the destination.
const DESTINATION_PROGRAMS = new Set(['cp', 'mv', 'install', 'rsync']);
const SERVICE_VERBS = new Set(['stop', 'disable', 'mask', 'kill', 'edit', 'restart', 'try-restart', 'reload-or-restart']);
const DOCKER_STOP_VERBS = new Set(['stop', 'kill', 'rm', 'restart', 'down', 'pause']);
const PROCESS_KILL_PROGRAMS = new Set(['pkill', 'killall']);
// The container name of the cloudbot container: cloudbot, cloudbot-cloudbot-1 or a copy with a number.
const CLOUDBOT_CONTAINER_PATTERN = /^cloudbot(-cloudbot)?(-\d+)?$/;
// Programs that write to a disk when one of their arguments is a device. For cp only the destination counts.
const DEVICE_ARG_PROGRAMS = new Set(['cp', 'tee', 'wipefs', 'shred', 'fdisk', 'sfdisk', 'sgdisk', 'parted', 'blkdiscard']);
// Read-only forms of the partition tools: fdisk -l, sfdisk --list and parted print. Their other forms write.
const LISTING_PROGRAMS = new Set(['fdisk', 'sfdisk']);
const LISTING_OPTIONS = new Set(['-l', '--list']);
// With one of these, find only deletes what matches, so the start folder alone is not a wipe.
const FIND_FILTERS = new Set(['-name', '-iname', '-path', '-mtime', '-mmin']);
// find flags that act on each match. A find without them only lists, so it may name the data folder.
const FIND_ACTION_FLAGS = new Set(['-exec', '-execdir', '-delete']);
// Options of systemctl and docker compose whose value is the next word, so the value is not read as a command.
const SYSTEMCTL_VALUE_FLAGS = new Set(['-s', '--signal', '-p', '--property', '-t', '--type', '-H', '--host', '-M', '--machine']);
const COMPOSE_VALUE_FLAGS = new Set(['-f', '--file', '-p', '--project-name', '--env-file', '--profile']);
const NO_VALUE_FLAGS = new Set<string>();
// The file arguments of each tool that reads or writes files, checked the same way as a Bash command.
// Grep and Glob patterns are searches, not paths, so they are not checked for the vault.
const FILE_FIELDS_BY_TOOL = new Map<string, string[]>([
    ['Read', ['file_path']],
    ['Grep', ['path', 'glob']],
    ['Glob', ['path']],
    ['Edit', ['file_path']],
    ['Write', ['file_path']],
    ['NotebookEdit', ['notebook_path']],
]);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
// The field that holds a shell command. Text typed on the desktop can go into a terminal, so it is checked the same way.
const COMMAND_FIELD_BY_TOOL = new Map<string, string>([
    ['Bash', 'command'],
    ['mcp__cloudbot__desktop_type', 'text'],
]);

function normalizeCommand(command: string): string {
    // A backslash at the end of a line joins the lines. Any other line break ends the command, as a separator does.
    const joinedLines = command.replace(LINE_CONTINUATION_PATTERN, ' ');
    const separatedLines = joinedLines.replace(LINE_BREAK_PATTERN, ';');
    const unescaped = separatedLines.replace(/\\(.)/g, '$1');
    const unquoted = unescaped.replace(/["']/g, '');
    // Repeated slashes are one slash, so //etc//systemd is the same path as /etc/systemd.
    const singleSlashes = unquoted.replace(/\/+/g, '/');
    // ${HOME} is written as $HOME, because the braces would split the command.
    const homeVariable = singleSlashes.replace(/\$\{HOME\}/g, '$HOME');

    return homeVariable.split(/\s+/)
        .filter(word => word !== '')
        .join(' ');
}

function splitSegments(normalized: string): string[] {
    return normalized.split(SEPARATOR_PATTERN)
        .map(segment => segment.trim())
        .filter(segment => segment !== '');
}

// Wrappers such as sudo, keywords, options, numbers such as the timeout of timeout 5 or 10s, and VAR=value are skipped.
// The value of an option such as sudo -u bot is skipped too. One pass finds the first word that is not skipped,
// so a long run of wrappers costs no recursion.
function skipWrappers(words: string[]): string[] {
    const valueIndexList = words.flatMap((word, index) => (OPTIONS_WITH_VALUE.has(word) ? [index + 1] : []));
    const valueIndexes = new Set(valueIndexList);
    const commandIndex = words.findIndex((word, index) => !valueIndexes.has(index) && !isSkippedWord(word));

    return commandIndex === -1 ? [] : words.slice(commandIndex);
}

function isSkippedWord(word: string): boolean {
    return WRAPPER_WORDS.has(word) || KEYWORD_WORDS.has(word) || word.startsWith('-') || NUMBER_PATTERN.test(word) || ENV_ASSIGNMENT_PATTERN.test(word);
}

// The words that are not options. The value of each option in valueFlags is skipped, such as KILL in -s KILL.
function readPositionals(args: string[], valueFlags: Set<string>): string[] {
    const valueIndexList = args.flatMap((arg, index) => (valueFlags.has(arg) ? [index + 1] : []));
    const valueIndexes = new Set(valueIndexList);

    return args.filter((arg, index) => !valueIndexes.has(index) && !valueFlags.has(arg) && !arg.startsWith('-'));
}

function optionValueFlags(program: string, args: string[]): Set<string> {
    if (program === 'systemctl') {
        return SYSTEMCTL_VALUE_FLAGS;
    }

    const isCompose = program === 'docker-compose' || (program === 'docker' && args[0] === 'compose');

    return isCompose ? COMPOSE_VALUE_FLAGS : NO_VALUE_FLAGS;
}

// Repeated slashes are one slash. A trailing slash, or a trailing /. (the folder itself), is removed.
function normalizeTarget(target: string): string {
    const collapsed = target.replace(/\/+/g, '/');
    const trimmed = collapsed.replace(/(\/\.?)+$/, '');

    return trimmed === '' ? '/' : trimmed;
}

function isDotGlobOfWipeFolder(target: string): boolean {
    const match = DOT_GLOB_PATTERN.exec(target);

    if (match === null) {
        return false;
    }

    const base = match[1] ?? '';
    const folder = base === '' ? '/' : base;

    return WIPE_TARGETS.has(folder);
}

function isWipeTarget(target: string): boolean {
    const normalized = normalizeTarget(target);

    return WIPE_TARGETS.has(normalized) || isDotGlobOfWipeFolder(normalized);
}

function isVaultText(text: string): boolean {
    return VAULT_PATTERNS.some(pattern => pattern.test(text));
}

function isDataFolder(arg: string): boolean {
    return normalizeTarget(arg) === DATA_FOLDER;
}

// The unit folder itself or anything in it. Any write there is a change to the systemd units.
function isUnitPath(arg: string): boolean {
    const target = normalizeTarget(arg);

    return target === UNIT_FOLDER || target.startsWith(`${UNIT_FOLDER}/`);
}

function isCloudbotUnit(arg: string): boolean {
    return arg === 'cloudbot' || arg === 'cloudbot.service';
}

// Rules that look at the whole command text, so they also see redirections, quoted code and words of any part.
function checkWholeCommand(normalized: string): string | undefined {
    const compact = normalized.replace(/\s/g, '');

    if (FORK_BOMB_PATTERN.test(compact)) {
        return REASON_FORK_BOMB;
    }

    if (DISK_REDIRECT_PATTERN.test(normalized)) {
        return REASON_DISK;
    }

    if (UNIT_REDIRECT_PATTERN.test(normalized)) {
        return REASON_SERVICE;
    }

    return isVaultText(normalized) ? REASON_VAULT : undefined;
}

// A pipe into a shell runs what the text before it prints, so that text is checked again. Only the last part before
// the pipe is the input, and echo or printf print their arguments.
function checkPipeIntoShell(normalized: string): string | undefined {
    const match = PIPE_INTO_SHELL_PATTERN.exec(normalized);

    if (match === null) {
        return undefined;
    }

    const upstreamParts = splitSegments(match[1] ?? '');
    const stdinTexts = upstreamParts.map(printedArguments);

    return stdinTexts
        .map(checkCommandText)
        .find(reason => reason !== undefined);
}

// echo and printf hand their arguments on, so those are the text. Any other part is checked as it is.
function printedArguments(part: string): string {
    const [printed = '', ...printedArgs] = part.split(' ');

    return PRINT_PROGRAMS.has(printed) ? printedArgs.join(' ') : part;
}

function isListingForm(program: string, args: string[]): boolean {
    const isDiskListing = LISTING_PROGRAMS.has(program) && LISTING_OPTIONS.has(args[0] ?? '');
    const isPartedPrint = program === 'parted' && args.includes('print');

    return isDiskListing || isPartedPrint;
}

function checkRecursiveDelete(program: string, args: string[]): string | undefined {
    const isRecursive = args.some(arg => /^-[a-zA-Z]*[rR]/.test(arg) || arg === '--recursive');
    const targets = args.filter(arg => !arg.startsWith('-'));

    return program === 'rm' && isRecursive && targets.some(isWipeTarget) ? REASON_WIPE : undefined;
}

// find deletes every file below its start folder with -delete, or with -exec rm. A filter limits what it deletes.
function checkFindDelete(program: string, args: string[]): string | undefined {
    const isDelete = args.includes('-delete') || (args.includes('-exec') && args.includes('rm'));
    const hasFilter = args.some(arg => FIND_FILTERS.has(arg));
    const hasWipeTarget = args.some(isWipeTarget);

    return program === 'find' && isDelete && !hasFilter && hasWipeTarget ? REASON_WIPE : undefined;
}

function isFormatProgram(program: string): boolean {
    return program.startsWith('mkfs') || program === 'mkswap' || program === 'mke2fs';
}

function checkDisk(program: string, args: string[]): string | undefined {
    const isFormat = isFormatProgram(program) && args.some(arg => arg.includes('/dev/'));
    const isDdToDevice = program === 'dd' && args.some(arg => arg.startsWith('of=') && DISK_DEVICE_PATTERN.test(arg));
    // cp writes only to its last word. Every other tool here writes to the devices it is given.
    const writtenArgs = program === 'cp' ? args.slice(-1) : args;
    const isDeviceWrite = DEVICE_ARG_PROGRAMS.has(program) && !isListingForm(program, args) && writtenArgs.some(arg => DISK_DEVICE_PATTERN.test(arg));

    return isFormat || isDdToDevice || isDeviceWrite ? REASON_DISK : undefined;
}

// A find that only lists may name the data folder. With -exec, -execdir or -delete it may read or remove the vault.
function isDataFolderLister(program: string, args: string[]): boolean {
    const isFindListing = program === 'find' && !args.some(arg => FIND_ACTION_FLAGS.has(arg));

    return DATA_FOLDER_LISTERS.has(program) || isFindListing;
}

// Any command other than a listing gets the data folder refused, because the folder holds the vault files.
function checkDataFolderAccess(program: string, args: string[]): string | undefined {
    const namesFolder = args.some(isDataFolder);

    return namesFolder && !isDataFolderLister(program, args) ? REASON_VAULT : undefined;
}

// The subcommand of docker compose or docker-compose, such as down in docker compose -f file down.
function composeSubcommand(program: string, nonFlags: string[]): string | undefined {
    const [verb = '', ...rest] = nonFlags;

    if (program === 'docker-compose') {
        return verb;
    }

    if (program === 'docker' && verb === 'compose') {
        return rest[0];
    }

    return undefined;
}

// Whether the command edits the unit folder: any write in it, sed in place there, or a copy or move into it.
function isUnitFileEdit(program: string, args: string[]): boolean {
    if (UNIT_WRITE_PROGRAMS.has(program)) {
        return args.some(isUnitPath);
    }

    if (DESTINATION_PROGRAMS.has(program)) {
        const destination = args[args.length - 1] ?? '';

        return isUnitPath(destination);
    }

    if (program === 'sed') {
        const isInPlace = args.some(arg => IN_PLACE_FLAG_PATTERN.test(arg));

        return isInPlace && args.some(isUnitPath);
    }

    return false;
}

// Stopping, disabling or restarting the cloudbot unit or container, or changing its unit file. Status and logs pass.
function checkService(rawProgram: string, program: string, args: string[], nonFlags: string[]): string | undefined {
    const [verb = '', ...rest] = nonFlags;
    const isSystemctlStop = program === 'systemctl' && SERVICE_VERBS.has(verb) && rest.some(unit => unit.startsWith('cloudbot'));
    const isServiceStop = program === 'service' && args.some(isCloudbotUnit) && args.some(arg => SERVICE_VERBS.has(arg));
    const isInitStop = normalizeTarget(rawProgram) === INIT_SCRIPT && SERVICE_VERBS.has(verb);
    const isProcessKill = PROCESS_KILL_PROGRAMS.has(program) && args.some(arg => arg.includes('cloudbot'));
    const composeVerb = composeSubcommand(program, nonFlags) ?? '';
    const namesCloudbot = args.some(arg => arg.includes('cloudbot'));
    const isComposeStop = DOCKER_STOP_VERBS.has(composeVerb) && namesCloudbot;
    // docker stop cloudbot and docker container stop cloudbot. The container name must be a cloudbot container name.
    const containerWords = verb === 'container' ? rest : nonFlags;
    const [containerVerb = '', ...containerNames] = containerWords;
    const isContainerStop = program === 'docker' && DOCKER_STOP_VERBS.has(containerVerb) && containerNames.some(name => CLOUDBOT_CONTAINER_PATTERN.test(name));

    return isSystemctlStop || isServiceStop || isInitStop || isProcessKill || isComposeStop || isContainerStop || isUnitFileEdit(program, args)
        ? REASON_SERVICE
        : undefined;
}

// A shell or su started with a -c option runs its text as a command, so that text is checked again.
// A shell with a here-string reads the text after <<<, so that text is checked again too.
function checkSegment(segment: string): string | undefined {
    const segmentWords = segment.split(' ');
    const words = skipWrappers(segmentWords);
    const [rawProgram = '', ...args] = words;
    const programPath = rawProgram.split('/');
    const program = programPath.pop() ?? '';
    const valueFlags = optionValueFlags(program, args);
    const nonFlags = readPositionals(args, valueFlags);
    const shellFlagIndex = args.findIndex(arg => SHELL_C_FLAG_PATTERN.test(arg));
    const hereStringIndex = segment.indexOf(HERE_STRING);

    if (PAYLOAD_PROGRAMS.has(program) && shellFlagIndex !== -1) {
        const payloadWords = args.slice(shellFlagIndex + 1);
        const payloadText = payloadWords.join(' ');

        return checkCommandText(payloadText);
    }

    if (SHELL_PROGRAMS.has(program) && hereStringIndex !== -1) {
        const hereText = segment.slice(hereStringIndex + HERE_STRING.length);

        return checkCommandText(hereText);
    }

    if (program === 'eval') {
        const evalText = args.join(' ');

        return checkCommandText(evalText);
    }

    return checkRecursiveDelete(program, args)
        ?? checkFindDelete(program, args)
        ?? checkDisk(program, args)
        ?? checkDataFolderAccess(program, args)
        ?? checkService(rawProgram, program, args, nonFlags);
}

function checkCommandText(text: string): string | undefined {
    const normalized = normalizeCommand(text);
    const wholeReason = checkWholeCommand(normalized);

    if (wholeReason !== undefined) {
        return wholeReason;
    }

    const pipeReason = checkPipeIntoShell(normalized);

    if (pipeReason !== undefined) {
        return pipeReason;
    }

    return splitSegments(normalized)
        .map(checkSegment)
        .find(reason => reason !== undefined);
}

function readInputText(input: unknown, field: string): string {
    const value = (input as Record<string, unknown> | null)?.[field];

    return typeof value === 'string' ? value : '';
}

// Read, search and edit tools: a vault file or the data folder in any of their path fields is refused, and so is a
// write into the unit folder.
function checkFileTool(call: ToolCall): string | undefined {
    const fields = FILE_FIELDS_BY_TOOL.get(call.toolName) ?? [];
    const values = fields.map(field => readInputText(call.input, field));
    const isTooLong = values.some(value => value.length > MAX_COMMAND_LENGTH);

    if (isTooLong) {
        return REASON_TOO_LONG;
    }

    const isVaultAccess = values.some(value => isVaultText(value) || isDataFolder(value));

    if (isVaultAccess) {
        return REASON_VAULT;
    }

    const isUnitWrite = WRITE_TOOLS.has(call.toolName) && values.some(isUnitPath);

    return isUnitWrite ? REASON_SERVICE : undefined;
}

function checkCallText(call: ToolCall): string | undefined {
    const commandField = COMMAND_FIELD_BY_TOOL.get(call.toolName);

    if (commandField !== undefined) {
        const command = readInputText(call.input, commandField);

        return command.length > MAX_COMMAND_LENGTH ? REASON_TOO_LONG : checkCommandText(command);
    }

    if (FILE_FIELDS_BY_TOOL.has(call.toolName)) {
        return checkFileTool(call);
    }

    return undefined;
}

// The reason the bot is refused, or undefined when the call may go on to the review.
// The reason never repeats the command, because a command may hold a secret. A check that throws refuses the call.
function checkCommandFloor(call: ToolCall): string | undefined {
    try {
        return checkCallText(call);
    } catch {
        return REASON_UNCHECKED;
    }
}

export { checkCommandFloor };
