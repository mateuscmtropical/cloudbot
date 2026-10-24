import { readFile } from 'node:fs/promises';

interface ListeningProgramOptions {
    agentUser: string | undefined;
    readText?: (path: string) => Promise<string>;
}

const LISTEN_STATE = '0A';
const SOCKET_TABLES = ['/proc/net/tcp', '/proc/net/tcp6'];
// The desktop's own listeners, TigerVNC and the Chromium DevTools port. They run as the bot user too.
const DESKTOP_PORTS = new Set([5900, 9222]);
const PORT_RADIX = 16;
const SOCKET_STATE_COLUMN = 3;
const SOCKET_ADDRESS_COLUMN = 1;
const SOCKET_UID_COLUMN = 7;
const PASSWD_UID_COLUMN = 2;

function readAgentUid(passwd: string, agentUser: string): number | undefined {
    const entries = passwd.split('\n');
    const entry = entries.find(line => line.startsWith(`${agentUser}:`));
    const uidText = entry?.split(':')[PASSWD_UID_COLUMN];

    if (uidText === undefined || uidText === '') {
        return undefined;
    }

    const uid = Number(uidText);

    return Number.isInteger(uid) ? uid : undefined;
}

function readPort(address: string | undefined): number {
    const portText = address?.split(':')[1] ?? '';

    return Number.parseInt(portText, PORT_RADIX);
}

// A row of /proc/net/tcp looks like "0: 0100007F:170C 00000000:0000 0A ... 1001 ...". State 0A means listening.
function readListeningPorts(table: string, uid: number): number[] {
    const rows = table.split('\n')
        .slice(1);
    const rowFields = rows.map(row => row.trim()
        .split(/\s+/));
    const listening = rowFields.filter(fields => fields[SOCKET_STATE_COLUMN] === LISTEN_STATE && Number(fields[SOCKET_UID_COLUMN]) === uid);

    return listening.map(fields => readPort(fields[SOCKET_ADDRESS_COLUMN]));
}

// True when a program the bot user started listens on a port, such as a Node dev server. The desktop's ports do not count.
async function hasAgentProgramListening(options: ListeningProgramOptions): Promise<boolean> {
    if (options.agentUser === undefined) {
        return false;
    }

    const readText = options.readText ?? ((path: string) => readFile(path, 'utf8'));

    try {
        const passwd = await readText('/etc/passwd');
        const uid = readAgentUid(passwd, options.agentUser);

        if (uid === undefined) {
            return false;
        }

        const tableReads = SOCKET_TABLES.map(path => readText(path)
            .catch(() => ''));
        const tables = await Promise.all(tableReads);
        const portLists = tables.map(table => readListeningPorts(table, uid));
        const ports = portLists.flat();

        return ports.some(port => Number.isInteger(port) && !DESKTOP_PORTS.has(port));
    } catch {
        return false;
    }
}

export { hasAgentProgramListening, readAgentUid, readListeningPorts };
export type { ListeningProgramOptions };
