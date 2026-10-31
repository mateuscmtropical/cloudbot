import { describe, expect, it, vi } from 'vitest';

import type { ToolCall } from '../agent/AgentRunner.ts';
import { checkCommandFloor } from './commandFloor.ts';
import { createToolCallReviewer } from './createToolCallReviewer.ts';

function bash(command: string): ToolCall {
    return { toolName: 'Bash', input: { command } };
}

function read(filePath: string): ToolCall {
    return { toolName: 'Read', input: { file_path: filePath } };
}

function tool(toolName: string, input: Record<string, string>): ToolCall {
    return { toolName, input };
}

describe('command floor refuses', () => {
    it.each([
        ['a recursive delete of the root', 'rm -rf /'],
        ['a recursive delete of every top folder', 'rm -rf /*'],
        ['a recursive delete of the home folder with combined flags', 'rm -fr ~'],
        ['a recursive delete of the home folder with a slash', 'rm -rf ~/'],
        ['a recursive delete of $HOME', 'rm -rf $HOME'],
        ['a quoted recursive delete of the bot home', 'rm -rf "/home/bot"'],
        ['a recursive delete of the bot home with a trailing slash', 'rm -rf /home/bot/'],
        ['a recursive delete of root', 'rm -r /root'],
        ['a recursive delete of the cloudbot data folder', 'rm -rf /var/lib/cloudbot'],
        ['a recursive delete after sudo', 'sudo rm -rf /'],
        ['a recursive delete after a change of folder', 'cd /tmp && rm -rf /'],
        ['a recursive delete inside sh -c', 'bash -c "rm -rf /"'],
        ['a recursive delete after sudo with a user option', 'sudo -u bot rm -rf /'],
        ['a recursive delete after sudo with a group option', 'sudo -g x rm -rf /'],
        ['a recursive delete after timeout with a signal option', 'timeout -s KILL 5 rm -rf /'],
        ['a recursive delete of the workspaces folder', 'rm -rf /var/lib/cloudbot-workspaces'],
        ['a recursive delete of the workspaces folder with a star', 'rm -rf /var/lib/cloudbot-workspaces/*'],
        ['a recursive delete of the uploads folder with a trailing slash', 'rm -rf /var/lib/cloudbot-uploads/'],
        ['a recursive delete of the uploads folder with a star', 'rm -rf /var/lib/cloudbot-uploads/*'],
        ['a recursive delete of $HOME in braces', 'rm -rf ${HOME}'],
        ['a recursive delete of $HOME in braces with a star', 'rm -rf ${HOME}/*'],
        ['a find delete from the root', 'find / -delete'],
        ['a find delete from the home folder', 'find ~ -delete'],
        ['a find exec rm from the root', 'find / -exec rm {} +'],
        ['an eval of a recursive delete', 'eval "rm -rf /"'],
        ['a recursive delete after a newline', 'echo hi\nrm -rf /'],
        ['a recursive delete after a backtick', 'echo `rm -rf /`'],
        ['a recursive delete inside an if block', 'if true; then rm -rf /; fi'],
        ['a recursive delete inside a for loop', 'for d in a; do rm -rf $HOME; done'],
        ['a recursive delete after a negation', '! rm -rf /'],
        ['a recursive delete after a time unit', 'timeout 10s rm -rf /'],
        ['a shell with a combined -lc flag', 'bash -lc "rm -rf /"'],
        ['a shell with a combined -xc flag', 'bash -xc "rm -rf /"'],
        ['su with -c', 'su -c "rm -rf /"'],
        ['ionice before a recursive delete', 'ionice -c 3 rm -rf /'],
        ['a recursive delete of the root children', 'rm -rf /root/*'],
        ['a recursive delete of the root with a double slash', 'rm -rf //'],
        ['a recursive delete of the root with a dot', 'rm -rf /.'],
        ['a recursive delete of the bot home with a dot', 'rm -rf /home/bot/.'],
        ['a recursive delete of the data folder with a dot', 'rm -rf /var/lib/cloudbot/.'],
        ['a recursive delete of the dot files of home', 'rm -rf $HOME/.*'],
        ['a recursive delete of the dot files with a bracket', 'rm -rf ~/.[a-z]*'],
        ['a find delete of home with a type filter', 'find ~ -type f -delete'],
        ['a find delete of home with a size filter', 'find ~ -size +1k -delete'],
        ['a grep of the data folder', 'grep -r . /var/lib/cloudbot'],
        ['a find exec cat in the data folder', 'find /var/lib/cloudbot -type f -exec cat {} +'],
        ['a cat of the data folder itself', 'cat /var/lib/cloudbot'],
        ['a cat of the vault files with a glob', 'cat vault*'],
        ['a cat of the vault key with a glob', 'cat vault.k*'],
        ['a cat of the data folder with a vault glob', 'cat /var/lib/cloudbot/v*'],
        ['a cat of the vault prefix in the data folder', 'cat /var/lib/cloudbot/vault'],
        ['a pipe of echoed text into sh', 'echo "rm -rf /" | sh'],
        ['a pipe of echoed text into bash', 'echo rm -rf / | bash'],
        ['a here-string into bash', 'bash <<< "rm -rf /"'],
        ['a recursive delete after a pipe into sh', 'cd /tmp && echo rm -rf / | sh'],
        ['a recursive delete through a double slash', 'rm -rf //home//bot'],
        ['a pipe of echoed text into sh after sudo', 'echo "rm -rf /" | sudo sh'],
        ['a pipe of echoed text into sh after env', 'echo "rm -rf /" | env sh'],
        ['a pipe of echoed text into a shell by path', 'echo "rm -rf /" | /bin/sh'],
        ['a pipe of echoed text into a shell by path after sudo', 'echo "rm -rf /" | sudo /bin/bash'],
        ['a pipe of an earlier echo into sh', 'echo "rm -rf /"; echo ok | sh'],
        ['a recursive delete of the root after a long run of sudo', 'sudo '.repeat(3000) + 'rm -rf /'],
        ['a find exec of the data folder with execdir', 'find /var/lib/cloudbot -execdir cat {} ;'],
        ['the fdisk listing form with the device first', 'fdisk /dev/sda -l'],
    ])('%s', (_name, command) => {
        expect(checkCommandFloor(bash(command)))
            .toBeDefined();
    });

    it.each([
        ['mkfs on a disk partition', 'mkfs.ext4 /dev/sdb1'],
        ['dd onto a disk device', 'dd if=/dev/zero of=/dev/sda bs=1M'],
        ['a redirect onto a disk device', 'echo x > /dev/sda'],
        ['wipefs on a disk device', 'wipefs -a /dev/nvme0n1'],
        ['a fork bomb', ':(){ :|:& };:'],
        ['a fork bomb with no spaces', 'bomb(){bomb|bomb&};bomb'],
        ['stopping the cloudbot unit', 'systemctl stop cloudbot'],
        ['disabling the cloudbot unit with a flag', 'systemctl disable --now cloudbot.service'],
        ['editing the cloudbot unit', 'systemctl edit cloudbot'],
        ['restarting the cloudbot unit with try-restart', 'systemctl try-restart cloudbot'],
        ['reloading the cloudbot unit with reload-or-restart', 'systemctl reload-or-restart cloudbot.service'],
        ['stopping a unit whose name starts with cloudbot', 'systemctl stop cloudbot-test'],
        ['removing the cloudbot unit file', 'rm /etc/systemd/system/cloudbot.service'],
        ['writing the cloudbot unit file', 'echo x > /etc/systemd/system/cloudbot.service'],
        ['editing the cloudbot unit file in place', 'sed -i s/a/b/ /etc/systemd/system/cloudbot.service'],
        ['copying a file over the cloudbot unit file', 'cp x.service /etc/systemd/system/cloudbot.service'],
        ['the cloudbot service stopped by service', 'service cloudbot stop'],
        ['killing processes named cloudbot', 'pkill -f cloudbot'],
        ['killing cloudbot by killall', 'killall cloudbot'],
        ['stopping the cloudbot container', 'docker stop cloudbot'],
        ['removing the cloudbot container', 'docker container rm cloudbot'],
        ['killing the cloudbot container by container', 'docker container kill cloudbot'],
        ['bringing the cloudbot compose project down', 'docker compose -p cloudbot down'],
        ['removing the cloudbot compose project with docker-compose', 'docker-compose -p cloudbot rm'],
        ['reading the vault file in the data folder', 'cat /var/lib/cloudbot/vault.json'],
        ['reading the push key file in the data folder', 'cat /var/lib/cloudbot/push-vapid.json'],
        ['copying the push key file by name', 'cp push-vapid.json /tmp/k'],
        ['reading the push key file inside sh -c', 'bash -c "cat push-vapid.json"'],
        ['reading the push key file with a glob', 'cat /var/lib/cloudbot/push-vapid.*'],
        ['reading the push key file by a short glob', 'cat push-vapid*'],
        ['reading the vault key through a redirect', 'base64 < vault.key'],
        ['copying the vault key', 'cp ~/vault.key /tmp/k'],
        ['reading the vault file inside sh -c', 'bash -c "cat vault.json"'],
        ['reading the vault key from python', `python3 -c "print(open('/var/lib/cloudbot/vault.key').read())"`],
        ['copying the vault key with brace expansion', 'cp vault.key{,.bak}'],
        ['reading the vault files by a glob', 'cat /var/lib/cloudbot/vault.*'],
        ['reading everything in the data folder', 'cat /var/lib/cloudbot/*'],
        ['a copy of the data folder with tar', 'tar czf /tmp/b.tgz /var/lib/cloudbot'],
        ['a recursive copy of the data folder', 'cp -r /var/lib/cloudbot /tmp/x'],
        ['a loop device written by dd', 'dd if=x of=/dev/loop0'],
        ['mkfs on an md device', 'mkfs.ext4 /dev/md0'],
        ['cp onto a disk device', 'cp image.img /dev/sda'],
        ['tee onto a disk device', 'tee /dev/sda'],
        ['fdisk on a disk', 'fdisk /dev/sda'],
        ['parted on a disk', 'parted /dev/sda mklabel gpt'],
        ['blkdiscard on a disk', 'blkdiscard /dev/nvme0n1'],
        ['mkswap on a disk partition', 'mkswap /dev/sdb2'],
        ['mke2fs on a disk partition', 'mke2fs -t ext4 /dev/sdb1'],
        ['stopping the cloudbot container by name', 'docker stop cloudbot-cloudbot-1'],
        ['removing the cloudbot compose container by force', 'docker rm -f cloudbot-cloudbot-1'],
        ['killing the cloudbot compose container', 'docker kill cloudbot-cloudbot-1'],
        ['stopping cloudbot with the init script', '/etc/init.d/cloudbot stop'],
        ['restarting cloudbot with the init script', '/etc/init.d/cloudbot restart'],
        ['stopping the cloudbot service with its full name', 'service cloudbot.service stop'],
        ['killing the cloudbot unit with a signal option', 'systemctl -s KILL kill cloudbot'],
        ['bringing the compose project down by its file', 'docker compose -f /opt/cloudbot/docker/compose.yaml down'],
        ['a copy into the unit folder', 'cp x /etc/systemd/system/'],
        ['a move onto the unit file', 'mv x.service /etc/systemd/system/cloudbot.service'],
        ['an install into the unit folder', 'install -m 644 x /etc/systemd/system/cloudbot.service'],
        ['a copy with doubled slashes into the unit folder', 'rsync x //etc//systemd//system/cloudbot.service'],
        ['a redirect with doubled slashes into the unit file', 'echo x > //etc/systemd/system/cloudbot.service'],
    ])('%s', (_name, command) => {
        expect(checkCommandFloor(bash(command)))
            .toBeDefined();
    });

    it.each([
        ['the Read tool on a vault file', tool('Read', { file_path: '/var/lib/cloudbot/vault.key' })],
        ['the Read tool on the other vault file', tool('Read', { file_path: '/var/lib/cloudbot/vault.json' })],
        ['the Read tool on the push key file', tool('Read', { file_path: '/var/lib/cloudbot/push-vapid.json' })],
        ['the Write tool on the push key file', tool('Write', { file_path: '/home/bot/push-vapid.json' })],
        ['the Grep tool with a push key glob', tool('Grep', { path: '/home/bot', glob: '*push-vapid.json' })],
        ['the Grep tool with a vault glob', tool('Grep', { path: '/home/bot', glob: '*vault.json' })],
        ['the Glob tool on the data folder', tool('Glob', { path: '/var/lib/cloudbot' })],
        ['the Grep tool on the data folder', tool('Grep', { path: '/var/lib/cloudbot', pattern: 'key' })],
        ['the Edit tool on a vault file', tool('Edit', { file_path: '/var/lib/cloudbot/vault.json' })],
        ['the Write tool on a vault file', tool('Write', { file_path: '/home/bot/vault.key' })],
        ['the NotebookEdit tool on a vault file', tool('NotebookEdit', { notebook_path: '/home/bot/vault.key' })],
        ['the Write tool on the cloudbot unit file', tool('Write', { file_path: '/etc/systemd/system/cloudbot.service' })],
        ['the Edit tool on the cloudbot unit file', tool('Edit', { file_path: '/etc/systemd/system/cloudbot.service' })],
        ['the Write tool on a file in the unit folder', tool('Write', { file_path: '//etc//systemd/system/other.service' })],
    ])('refuses %s', (_name, call) => {
        expect(checkCommandFloor(call))
            .toBeDefined();
    });

    it('refuses the Read tool on a vault file', () => {
        expect(checkCommandFloor(read('/var/lib/cloudbot/vault.key')))
            .toBeDefined();
        expect(checkCommandFloor(read('/var/lib/cloudbot/vault.json')))
            .toBeDefined();
    });
});

describe('command floor lets through near misses', () => {
    it.each([
        ['a recursive delete of a build folder', 'rm -rf ./build'],
        ['a recursive delete of node_modules', 'rm -rf node_modules'],
        ['a rm text quoted in echo', 'echo "rm -rf /"'],
        ['a rm text quoted in a commit message', 'git commit -m "rm -rf /"'],
        ['dd to a file', 'dd if=/dev/zero of=disk.img bs=1M count=1'],
        ['the status of the cloudbot unit', 'systemctl status cloudbot'],
        ['the logs of the cloudbot container', 'docker logs cloudbot'],
        ['reading a normal file', 'cat notes.txt'],
        ['listing the data folder', 'ls /var/lib/cloudbot'],
        ['a redirect to /dev/null', 'make build 2>/dev/null'],
        ['a recursive delete of a tmp folder', 'rm -rf /tmp/work'],
        ['a recursive delete of a dot folder in a project', 'rm -rf /home/bot/project/.cache'],
        ['a find delete of a name in the current folder', 'find . -name x -delete'],
        ['a find by name from the root', 'find / -name foo'],
        ['a find delete from the root with a name filter', 'find / -name x -delete'],
        ['a sudo user option before a listing', 'sudo -u bot ls /'],
        ['an in-place edit of another unit file', 'sed -i s/a/b/ deploy/systemd/cloudbot.service'],
        ['copying the unit file out', 'cp /etc/systemd/system/cloudbot.service /tmp/'],
        ['reading the unit file with sed', 'sed -n 1,5p /etc/systemd/system/cloudbot.service'],
        ['mkfs on an image file', 'mkfs.ext4 disk.img'],
        ['removing a container named cloudbot-test', 'docker rm -f cloudbot-test'],
        ['bringing another compose project down', 'docker compose down'],
        ['stopping another compose project', 'docker compose stop'],
        ['restarting another compose project', 'docker compose restart'],
        ['the status of the cloudbot service by service', 'service cloudbot status'],
        ['a shell script run without -c', 'bash script.sh'],
        ['a listing of the data folder with cd', 'cd /var/lib/cloudbot'],
        ['a find without delete of home', 'find / -type f -name x'],
        ['the read-only listing of a disk with fdisk', 'fdisk -l /dev/sda'],
        ['the read-only print of a disk with parted', 'parted /dev/sda print'],
        ['a copy from a disk device', 'cp /dev/sda1 /tmp/img'],
        ['a compose exec of cloudbot with a file path', 'docker compose -f /opt/cloudbot/docker/compose.yaml exec cloudbot rm /tmp/x'],
        ['a pipe of echoed text into sh that is harmless', 'echo "hello" | sh'],
        ['a pipe of a file into sh', 'cat notes.sh | sh'],
        ['a pipe of echoed hello into sh after sudo', 'echo "hello" | sudo sh'],
        ['the read-only listing of a disk with sfdisk', 'sfdisk -l /dev/sda'],
        ['a df of the data folder', 'df /var/lib/cloudbot'],
        ['a test of the data folder', 'test -d /var/lib/cloudbot'],
        ['a find of the data folder without an action', 'find /var/lib/cloudbot -name x'],
        ['a tree of the data folder', 'tree /var/lib/cloudbot'],
    ])('%s', (_name, command) => {
        expect(checkCommandFloor(bash(command)))
            .toBeUndefined();
    });

    it.each([
        ['the Read tool on a normal file', tool('Read', { file_path: '/home/bot/notes.txt' })],
        ['the Read tool on the cloudbot unit file', tool('Read', { file_path: '/etc/systemd/system/cloudbot.service' })],
        ['the Edit tool on a file with a vault-like name', tool('Edit', { file_path: '/home/bot/vault-notes.md' })],
        ['the Glob tool on source files', tool('Glob', { pattern: '**/*.ts' })],
        ['the Glob tool with a vault glob as its pattern', tool('Glob', { pattern: '**/vault.*' })],
        ['the Grep tool with a vault name as its pattern', tool('Grep', { path: '/home/bot', pattern: 'vault.json' })],
    ])('lets %s through', (_name, call) => {
        expect(checkCommandFloor(call))
            .toBeUndefined();
    });
});

describe('command floor on the desktop', () => {
    it('checks text typed on the desktop like a command, since it can go into a terminal', () => {
        expect(checkCommandFloor(tool('mcp__cloudbot__desktop_type', { text: 'rm -rf ~' })))
            .toBe(checkCommandFloor(bash('rm -rf ~')));
        expect(checkCommandFloor(tool('mcp__cloudbot__desktop_type', { text: 'rm -rf ~' })))
            .toBeDefined();
        expect(checkCommandFloor(tool('mcp__cloudbot__desktop_type', { text: 'npm test' })))
            .toBeUndefined();
    });
});

describe('command floor limits and failures', () => {
    it('refuses a bash command longer than 20000 characters', () => {
        expect(checkCommandFloor(bash('a'.repeat(20001))))
            .toBe('The bot never runs a command longer than 20000 characters.');
    });

    it('checks a bash command of exactly 20000 characters', () => {
        expect(checkCommandFloor(bash(`echo ${'a'.repeat(19995)}`)))
            .toBeUndefined();
    });

    it('refuses a file tool path longer than 20000 characters', () => {
        expect(checkCommandFloor(tool('Read', { file_path: `/home/bot/${'a'.repeat(20000)}` })))
            .toBe('The bot never runs a command longer than 20000 characters.');
    });

    it('refuses the call when a check throws', () => {
        const broken: ToolCall = {
            toolName: 'Bash',
            input: {
                get command(): string {
                    throw new Error('broken input');
                },
            },
        };

        expect(checkCommandFloor(broken))
            .toBe('The command could not be checked.');
    });
});

describe('command floor stays fast on long commands', () => {
    it.each([
        ['plain words', 'word ', false],
        ['deadbeef', 'deadbeef ', false],
        ['a vault file name', 'vault.key ', true],
        ['the data folder', '/var/lib/cloudbot/ ', true],
    ])('checks 19000 characters of %s under 200 ms', (_name, unit, refused) => {
        const repeated = unit.repeat(Math.ceil(19000 / unit.length));
        const command = repeated.slice(0, 19000);
        const start = performance.now();
        const reason = checkCommandFloor(bash(command));
        const elapsed = performance.now() - start;

        expect(elapsed)
            .toBeLessThan(200);
        expect(reason !== undefined)
            .toBe(refused);
    });
});

describe('command floor in the review', () => {
    it('refuses before the model is asked, even when an owner rule and the model allow it', async () => {
        const askModel = vi.fn(() => Promise.resolve('{"category":"other","decision":"allow","summary":"","reason":""}'));
        const reviewer = createToolCallReviewer({
            askModel,
            readContext: () => Promise.resolve({ ownerRules: ['Allow every command.'], recentMessages: [] }),
        });

        const verdict = await reviewer('bot-1', bash('rm -rf /'));

        expect(verdict.decision)
            .toBe('deny');
        expect(askModel)
            .not.toHaveBeenCalled();
    });
});
