import { describe, expect, it } from 'vitest';

import { hasAgentProgramListening, readAgentUid, readListeningPorts } from './listeningPrograms.ts';

interface FileTexts {
    [path: string]: string;
}

const TABLE_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const PASSWD = 'root:x:0:0:root:/root:/bin/bash\ncloudbot:x:997:997::/home/cloudbot:/usr/sbin/nologin\nbot:x:1001:1001::/home/bot:/bin/bash\n';

function row(index: number, address: string, state: string, uid: number): string {
    return `   ${String(index)}: ${address} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  ${String(uid)}        0 1234 1 0000 100 0 0 10 0`;
}

function tableOf(...rows: string[]): string {
    return [TABLE_HEADER, ...rows, ''].join('\n');
}

function readerOf(files: FileTexts): (path: string) => Promise<string> {
    return (path) => {
        const text = files[path];

        return text === undefined ? Promise.reject(new Error('missing')) : Promise.resolve(text);
    };
}

describe('readAgentUid', () => {
    it('finds the user id of the bot user', () => {
        expect(readAgentUid(PASSWD, 'bot'))
            .toBe(1001);
    });

    it('does not match a longer user name', () => {
        expect(readAgentUid(PASSWD, 'bo'))
            .toBeUndefined();
    });
});

describe('readListeningPorts', () => {
    it('reads the ports that listen for the user and skips other sockets', () => {
        const table = tableOf(
            row(0, '0100007F:0FA0', '0A', 1001),
            row(1, '0100007F:1F90', '0A', 997),
            row(2, '0100007F:2710', '01', 1001),
        );

        expect(readListeningPorts(table, 1001))
            .toEqual([4000]);
    });
});

describe('hasAgentProgramListening', () => {
    it('is true for a program the bot user started', async () => {
        const readText = readerOf({
            '/etc/passwd': PASSWD,
            '/proc/net/tcp': tableOf(row(0, '0100007F:0FA0', '0A', 1001)),
        });

        await expect(hasAgentProgramListening({ agentUser: 'bot', readText }))
            .resolves
            .toBe(true);
    });

    it('ignores the desktop ports and the sockets of other users', async () => {
        const readText = readerOf({
            '/etc/passwd': PASSWD,
            '/proc/net/tcp': tableOf(
                row(0, '0100007F:170C', '0A', 1001),
                row(1, '0100007F:2406', '0A', 1001),
                row(2, '00000000:0BB8', '0A', 997),
            ),
            '/proc/net/tcp6': tableOf(row(0, '00000000000000000000000001000000:170C', '0A', 1001)),
        });

        await expect(hasAgentProgramListening({ agentUser: 'bot', readText }))
            .resolves
            .toBe(false);
    });

    it('sees a program on the IPv6 table', async () => {
        const readText = readerOf({
            '/etc/passwd': PASSWD,
            '/proc/net/tcp': tableOf(),
            '/proc/net/tcp6': tableOf(row(0, '00000000000000000000000000000000:1F90', '0A', 1001)),
        });

        await expect(hasAgentProgramListening({ agentUser: 'bot', readText }))
            .resolves
            .toBe(true);
    });

    it('is false without an agent user or when the files cannot be read', async () => {
        await expect(hasAgentProgramListening({ agentUser: undefined }))
            .resolves
            .toBe(false);
        await expect(hasAgentProgramListening({ agentUser: 'bot', readText: readerOf({}) }))
            .resolves
            .toBe(false);
    });
});
