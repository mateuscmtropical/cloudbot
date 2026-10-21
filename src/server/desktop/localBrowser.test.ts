import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { BrowserError, DESKTOP_DEVTOOLS_URL, GATE_REFUSED_ERROR } from './BrowserControl.ts';
import type { BrowserControl, PageText } from './BrowserControl.ts';
import {
    answerFromResponse,
    buildLocalBrowserArguments,
    buildLocalBrowserTools,
    checkLocalBrowserGate,
    commandLineNamesGate,
    createLocalBrowserSpawn,
    findLocalBrowser,
    inspectProfileBrowser,
    localGatePortFor,
    minimalBrowserEnvironment,
    parsePort,
    planLocalBrowser,
    readDevtoolsPort,
    startPlannedGate,
    verifyLocalBrowserGate,
} from './localBrowser.ts';
import type { LocalBrowserPlan, ReuseDependencies, VersionProbe } from './localBrowser.ts';

const PROFILE = '/data/browser-profile';
const SOCKET_PATH = '/devtools/browser/abc';
const GATE_PORT = 52000;
const LOADED_PAGE: PageText = { title: '', url: 'http://127.0.0.1:1/', text: '', isTruncated: false };

interface GateSpy extends Pick<BrowserControl, 'enable' | 'disable'> {
    enableCount: number;
    disabledReasons: string[];
}

// The two calls a gate check makes on the browser: enable on a pass, disable otherwise.
function gateSpy(): GateSpy {
    const disabledReasons: string[] = [];
    const spy: GateSpy = {
        enableCount: 0,
        disabledReasons,
        enable: () => {
            spy.enableCount += 1;
        },
        disable: (reason: string) => {
            disabledReasons.push(reason);
        },
    };

    return spy;
}

// The browser of the check as it is seen: a refused private address, and no connection reached the listener.
function refusingProbe(): Pick<BrowserControl, 'open'> {
    return {
        open: () => Promise.reject(new BrowserError(`The page could not be opened: net::${GATE_REFUSED_ERROR}. The browser refused this address.`)),
    };
}

// A browser that bypasses the gate. The fake connects to the address it is given, which is the test's own loopback listener.
function bypassingProbe(): Pick<BrowserControl, 'open'> {
    return {
        open: (rawUrl: string) => new Promise<PageText>((resolve, reject) => {
            const target = new URL(rawUrl);
            const socket = connect({ host: target.hostname, port: Number(target.port) });

            socket.on('data', () => {
                socket.destroy();
                resolve(LOADED_PAGE);
            });
            socket.on('error', reject);
        }),
    };
}

describe('findLocalBrowser', () => {
    it('finds Edge on Windows when Chrome is not installed', () => {
        const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
        const found = findLocalBrowser({
            platform: 'win32',
            env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
            exists: path => path === edgePath,
        });

        expect(found)
            .toBe(edgePath);
    });

    it('returns undefined when no browser is installed', () => {
        const found = findLocalBrowser({ platform: 'linux', env: {}, exists: () => false });

        expect(found)
            .toBeUndefined();
    });

    it('does not look for the snap package of Chromium', () => {
        const found = findLocalBrowser({ platform: 'linux', env: {}, exists: path => path === '/snap/bin/chromium' });

        expect(found)
            .toBeUndefined();
    });

    it('uses the path the owner set, and ignores the install paths when it is set', () => {
        const found = findLocalBrowser({
            platform: 'linux',
            env: { CLOUDBOT_BROWSER_PATH: '/opt/brave/brave' },
            exists: path => path === '/opt/brave/brave' || path === '/usr/bin/chromium',
        });

        expect(found)
            .toBe('/opt/brave/brave');
    });

    it('returns undefined for a configured path that does not exist', () => {
        const found = findLocalBrowser({
            platform: 'linux',
            env: { CLOUDBOT_BROWSER_PATH: '/opt/missing' },
            exists: path => path === '/usr/bin/chromium',
        });

        expect(found)
            .toBeUndefined();
    });
});

describe('buildLocalBrowserArguments', () => {
    const argumentList = buildLocalBrowserArguments({ profileDir: PROFILE, gatePort: GATE_PORT });

    it('keeps DevTools on loopback, on a port Chrome picks', () => {
        expect(argumentList)
            .toContain('--remote-debugging-port=0');
        expect(argumentList)
            .toContain('--remote-debugging-address=127.0.0.1');
    });

    it('keeps the window reported as visible, so screencast frames keep coming', () => {
        expect(argumentList)
            .toContain('--disable-backgrounding-occluded-windows');
    });

    it('turns QUIC off, since it would go past the gate over UDP', () => {
        expect(argumentList)
            .toContain('--disable-quic');
    });

    it('uses the bot profile and routes every request through the gate on its own port', () => {
        expect(argumentList)
            .toContain(`--user-data-dir=${PROFILE}`);
        expect(argumentList)
            .toContain('--proxy-server=socks5://127.0.0.1:52000');
        expect(argumentList)
            .toContain('--proxy-bypass-list=<-loopback>');
    });
});

describe('minimalBrowserEnvironment', () => {
    it('keeps what Chrome needs to start, and drops the server secrets', () => {
        const kept = minimalBrowserEnvironment({
            PATH: '/usr/bin',
            SystemRoot: 'C:\\Windows',
            ANTHROPIC_API_KEY: 'secret',
            CLOUDBOT_SECRET: 'secret',
        });

        expect(kept)
            .toEqual({ PATH: '/usr/bin', SystemRoot: 'C:\\Windows' });
    });

    it('keeps the desktop and session variables that Linux and macOS browsers need', () => {
        const kept = minimalBrowserEnvironment({
            XAUTHORITY: '/home/owner/.Xauthority',
            WAYLAND_DISPLAY: 'wayland-0',
            XDG_RUNTIME_DIR: '/run/user/1000',
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
            XDG_SESSION_TYPE: 'wayland',
            LANG: 'pt_BR.UTF-8',
            ProgramData: 'C:\\ProgramData',
            windir: 'C:\\Windows',
            USERNAME: 'owner',
            HOMEDRIVE: 'C:',
            HOMEPATH: '\\Users\\owner',
        });

        expect(Object.keys(kept))
            .toHaveLength(11);
    });

    it('never passes proxy or API variables to the browser', () => {
        const kept = minimalBrowserEnvironment({
            HTTPS_PROXY: 'http://proxy.example:8080',
            OPENAI_API_KEY: 'secret',
        });

        expect(kept)
            .toEqual({});
    });
});

describe('createLocalBrowserSpawn', () => {
    it('keeps a port file that was written before the browser started', async () => {
        const profileDir = mkdtempSync(join(tmpdir(), 'cloudbot-profile-'));
        const portFilePath = join(profileDir, 'DevToolsActivePort');
        const earlier = new Date(Date.now() - 60_000);

        writeFileSync(portFilePath, '9999\n/devtools/browser/old\n');
        utimesSync(portFilePath, earlier, earlier);

        const child = createLocalBrowserSpawn(profileDir, {})(process.execPath, ['-e', '']);

        await waitForExit(child);
        expect(existsSync(portFilePath))
            .toBe(true);
        rmSync(profileDir, { recursive: true, force: true });
    });

    it('removes the port file that the browser wrote when it exits', async () => {
        const profileDir = mkdtempSync(join(tmpdir(), 'cloudbot-profile-'));
        const portFilePath = join(profileDir, 'DevToolsActivePort');
        const script = 'require("fs").writeFileSync(process.argv[1], "9999\\n/devtools/browser/new\\n")';

        const child = createLocalBrowserSpawn(profileDir, {})(process.execPath, ['-e', script, portFilePath]);

        await waitForExit(child);
        expect(existsSync(portFilePath))
            .toBe(false);
        rmSync(profileDir, { recursive: true, force: true });
    });
});

function waitForExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
        child.once('exit', () => {
            resolve();
        });
    });
}

describe('readDevtoolsPort', () => {
    it('reads the port of the profile, and is undefined without the file', () => {
        const profileDir = mkdtempSync(join(tmpdir(), 'cloudbot-profile-'));

        expect(readDevtoolsPort(profileDir))
            .toBeUndefined();
        writeFileSync(join(profileDir, 'DevToolsActivePort'), '51234\n/devtools/browser/abc\n');
        expect(readDevtoolsPort(profileDir))
            .toBe(51234);
        rmSync(profileDir, { recursive: true, force: true });
    });
});

describe('parsePort', () => {
    it('reads the first line as a port', () => {
        expect(parsePort('51234\n/devtools/browser/abc\n'))
            .toBe(51234);
    });

    it('rejects text that is not a port', () => {
        expect(parsePort(undefined))
            .toBeUndefined();
        expect(parsePort(''))
            .toBeUndefined();
        expect(parsePort('70000'))
            .toBeUndefined();
    });
});

describe('answerFromResponse', () => {
    it('reads a short answer in full', async () => {
        const answer = answerFromResponse(new Response('{"Browser":"Chrome/141.0.0.0"}'));

        await expect(answer.readBody())
            .resolves.toBe('{"Browser":"Chrome/141.0.0.0"}');
    });

    it('gives up on an answer larger than 64 KB', async () => {
        const answer = answerFromResponse(new Response('x'.repeat(70 * 1024)));

        await expect(answer.readBody())
            .resolves.toBeUndefined();
    });
});

describe('commandLineNamesGate', () => {
    it('names the gate port the browser was started with', () => {
        expect(commandLineNamesGate('chrome --proxy-server=socks5://127.0.0.1:52000 --no-first-run', 52000))
            .toBe(true);
    });

    it('does not take a longer port that starts with the same digits', () => {
        expect(commandLineNamesGate('chrome --proxy-server=socks5://127.0.0.1:520001', 52000))
            .toBe(false);
    });

    it('does not take another gate port', () => {
        expect(commandLineNamesGate('chrome --proxy-server=socks5://127.0.0.1:1080', 52000))
            .toBe(false);
    });
});

interface FakeBrowserOptions {
    portFileText?: string | undefined;
    answerBody?: string;
    // The answer is larger than the cap, so it cannot be read.
    bodyTooLarge?: boolean;
    probeError?: Error;
    socketUrl?: string;
    commandLine?: string;
    commandLineError?: Error;
}

// A fake DevTools for the profile. The probe records the address it was asked. The command line is read over the socket.
function fakeProfile(options: FakeBrowserOptions): { dependencies: ReuseDependencies; asked: string[]; socketsRead: string[]; removed: string[] } {
    const asked: string[] = [];
    const socketsRead: string[] = [];
    const removed: string[] = [];
    const socketUrl = options.socketUrl ?? `ws://127.0.0.1:51234${SOCKET_PATH}`;
    const answerBody = options.answerBody ?? JSON.stringify({ Browser: 'Chrome/141.0.0.0', webSocketDebuggerUrl: socketUrl });
    const probe: VersionProbe = (url) => {
        asked.push(url);

        if (options.probeError !== undefined) {
            return Promise.reject(options.probeError);
        }

        return Promise.resolve({ readBody: () => Promise.resolve(options.bodyTooLarge === true ? undefined : answerBody) });
    };
    const readCommandLine = (url: string): Promise<string> => {
        socketsRead.push(url);

        if (options.commandLineError !== undefined) {
            return Promise.reject(options.commandLineError);
        }

        return Promise.resolve(options.commandLine ?? `chrome.exe --user-data-dir=${PROFILE} --proxy-server=socks5://127.0.0.1:${String(GATE_PORT)} --no-first-run`);
    };

    return {
        dependencies: {
            readText: () => options.portFileText,
            removeFile: (filePath) => {
                removed.push(filePath);
            },
            probe,
            readCommandLine,
        },
        asked,
        socketsRead,
        removed,
    };
}

const PORT_FILE_TEXT = `51234\n${SOCKET_PATH}\n`;

describe('inspectProfileBrowser', () => {
    it('reuses the browser on the port of the profile when it is ours, on the gate port it was started with', async () => {
        const { dependencies, asked } = fakeProfile({ portFileText: PORT_FILE_TEXT });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'reusable', port: 51234, gatePort: GATE_PORT });
        expect(asked)
            .toEqual(['http://127.0.0.1:51234/json/version']);
    });

    it('accepts an Edge answer too', async () => {
        const answerBody = JSON.stringify({ Browser: 'Edg/141.0.0.0', webSocketDebuggerUrl: `ws://127.0.0.1:51234${SOCKET_PATH}` });
        const { dependencies } = fakeProfile({ portFileText: PORT_FILE_TEXT, answerBody });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toMatchObject({ status: 'reusable' });
    });

    it('is free when the profile has no port file, and asks nothing', async () => {
        const { dependencies, asked } = fakeProfile({ portFileText: undefined });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'free' });
        expect(asked)
            .toEqual([]);
    });

    it('is free and removes the port file when the port refuses the connection', async () => {
        const refused = new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } });
        const { dependencies, removed } = fakeProfile({ portFileText: PORT_FILE_TEXT, probeError: refused });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'free' });
        expect(removed)
            .toEqual([join(PROFILE, 'DevToolsActivePort')]);
    });

    it('is a leftover, and keeps the port file, when the port does not answer in time', async () => {
        const timeout = new Error('The operation was aborted due to timeout');
        const { dependencies, removed } = fakeProfile({ portFileText: PORT_FILE_TEXT, probeError: timeout });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'leftover' });
        expect(removed)
            .toEqual([]);
    });

    it('is free and removes the port file when the port answers with something that is not a browser', async () => {
        const { dependencies, removed } = fakeProfile({ portFileText: PORT_FILE_TEXT, answerBody: JSON.stringify({ Browser: 'SomeOtherServer/1.0' }) });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'free' });
        expect(removed)
            .toEqual([join(PROFILE, 'DevToolsActivePort')]);
    });

    it('is free and removes the port file when the answer is not JSON', async () => {
        const { dependencies, removed } = fakeProfile({ portFileText: PORT_FILE_TEXT, answerBody: '<html>' });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'free' });
        expect(removed)
            .toHaveLength(1);
    });

    it('is free and removes the port file when the answer is larger than the cap', async () => {
        const { dependencies, removed } = fakeProfile({ portFileText: PORT_FILE_TEXT, bodyTooLarge: true });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'free' });
        expect(removed)
            .toHaveLength(1);
    });

    it('keeps the port file of a Chrome that fails its identity, and is a leftover', async () => {
        const { dependencies, removed } = fakeProfile({ portFileText: PORT_FILE_TEXT, commandLine: 'chrome.exe --user-data-dir=/home/owner/chrome' });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'leftover' });
        expect(removed)
            .toEqual([]);
    });

    it('is a leftover when the socket path is not the one in line two of the port file', async () => {
        const socketUrl = 'ws://127.0.0.1:51234/devtools/browser/other';
        const { dependencies, socketsRead } = fakeProfile({ portFileText: PORT_FILE_TEXT, socketUrl });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'leftover' });
        expect(socketsRead)
            .toEqual([]);
    });

    it('is a leftover when the socket is not on loopback or not on its own port', async () => {
        const remote = fakeProfile({ portFileText: PORT_FILE_TEXT, socketUrl: `ws://10.0.0.5:51234${SOCKET_PATH}` });
        const otherPort = fakeProfile({ portFileText: PORT_FILE_TEXT, socketUrl: `ws://127.0.0.1:9999${SOCKET_PATH}` });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, remote.dependencies))
            .resolves.toEqual({ status: 'leftover' });
        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, otherPort.dependencies))
            .resolves.toEqual({ status: 'leftover' });
        expect(remote.socketsRead)
            .toEqual([]);
        expect(otherPort.socketsRead)
            .toEqual([]);
    });

    it('is a leftover when the browser runs another profile', async () => {
        const { dependencies } = fakeProfile({ portFileText: PORT_FILE_TEXT, commandLine: 'chrome.exe --user-data-dir=/home/owner/chrome --proxy-server=socks5://127.0.0.1:52000' });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'leftover' });
    });

    it('does not take a longer profile name for this one', async () => {
        const { dependencies } = fakeProfile({ portFileText: PORT_FILE_TEXT, commandLine: `chrome.exe --user-data-dir=${PROFILE}-other --proxy-server=socks5://127.0.0.1:52000` });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'leftover' });
    });

    it('is a leftover when the browser runs through another gate port', async () => {
        const commandLine = `chrome.exe --user-data-dir=${PROFILE} --proxy-server=socks5://127.0.0.1:1080`;
        const { dependencies } = fakeProfile({ portFileText: PORT_FILE_TEXT, commandLine });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'leftover' });
    });

    it('is a leftover when the command line cannot be read', async () => {
        const { dependencies } = fakeProfile({ portFileText: PORT_FILE_TEXT, commandLineError: new Error('socket closed') });

        await expect(inspectProfileBrowser(PROFILE, GATE_PORT, dependencies))
            .resolves.toEqual({ status: 'leftover' });
    });

    it('is a leftover when the gate port that was saved is not known', async () => {
        const { dependencies } = fakeProfile({ portFileText: PORT_FILE_TEXT });

        await expect(inspectProfileBrowser(PROFILE, undefined, dependencies))
            .resolves.toEqual({ status: 'leftover' });
    });

    it('reads a profile path that is quoted because it has spaces', async () => {
        const commandLine = `"chrome.exe" --user-data-dir="/data/my profile" --proxy-server=socks5://127.0.0.1:${String(GATE_PORT)}`;
        const { dependencies } = fakeProfile({ portFileText: PORT_FILE_TEXT, commandLine });

        await expect(inspectProfileBrowser('/data/my profile', GATE_PORT, dependencies))
            .resolves.toMatchObject({ status: 'reusable' });
    });
});

describe('checkLocalBrowserGate', () => {
    it('passes when the private address is refused and no connection reaches the listener', async () => {
        await expect(checkLocalBrowserGate(refusingProbe(), 0))
            .resolves.toBe('passed');
    });

    it('reports bypassed when a connection reaches the throwaway listener', async () => {
        await expect(checkLocalBrowserGate(bypassingProbe(), 0))
            .resolves.toBe('bypassed');
    });

    it('does not pass a connection refusal of the port, which a proxy bypass also gives', async () => {
        const probe: Pick<BrowserControl, 'open'> = {
            open: () => Promise.reject(new BrowserError('The page could not be opened: net::ERR_CONNECTION_REFUSED. The browser could not reach this address.')),
        };

        await expect(checkLocalBrowserGate(probe, 0))
            .resolves.toBe('notVerified');
    });

    it('reports not verified when the browser never answers', async () => {
        const probe: Pick<BrowserControl, 'open'> = {
            open: () => Promise.reject(new BrowserError('The browser is not running. Try again in a few seconds.')),
        };

        await expect(checkLocalBrowserGate(probe, 0))
            .resolves.toBe('notVerified');
    });
});

function liveOptions(): { signal: AbortSignal } {
    return { signal: new AbortController().signal };
}

describe('verifyLocalBrowserGate', () => {
    it('enables the browser tools when the gate refuses the private address', async () => {
        const spy = gateSpy();

        await expect(verifyLocalBrowserGate(refusingProbe(), spy, liveOptions()))
            .resolves.toBe('passed');
        expect(spy.enableCount)
            .toBe(1);
        expect(spy.disabledReasons)
            .toEqual([]);
    });

    it('turns the browser off when a private address is reached', async () => {
        const spy = gateSpy();

        await expect(verifyLocalBrowserGate(bypassingProbe(), spy, liveOptions()))
            .resolves.toBe('bypassed');
        expect(spy.enableCount)
            .toBe(0);
        expect(spy.disabledReasons)
            .toHaveLength(1);
    });

    it('runs the check again until it passes, and enables the tools then', async () => {
        const spy = gateSpy();
        const attempts: string[] = [];
        const probe: Pick<BrowserControl, 'open'> = {
            open: () => {
                attempts.push('open');

                if (attempts.length === 1) {
                    return Promise.reject(new Error('the browser is still starting'));
                }

                return Promise.reject(new BrowserError(`The page could not be opened: net::${GATE_REFUSED_ERROR}.`));
            },
        };

        await expect(verifyLocalBrowserGate(probe, spy, { ...liveOptions(), attemptsLeft: 0, retryDelayMs: 0 }))
            .resolves.toBe('passed');
        expect(attempts)
            .toHaveLength(2);
        expect(spy.enableCount)
            .toBe(1);
    });

    it('logs the retrying once, and the outcome once, however many checks run', async () => {
        const errors = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const logs = vi.spyOn(console, 'log')
            .mockImplementation(() => undefined);
        const attempts: string[] = [];
        const probe: Pick<BrowserControl, 'open'> = {
            open: () => {
                attempts.push('open');

                if (attempts.length < 3) {
                    return Promise.reject(new Error('the browser is still starting'));
                }

                return Promise.reject(new BrowserError(`The page could not be opened: net::${GATE_REFUSED_ERROR}.`));
            },
        };

        await verifyLocalBrowserGate(probe, gateSpy(), { ...liveOptions(), attemptsLeft: 0, retryDelayMs: 0 });

        expect(attempts)
            .toHaveLength(3);
        expect(errors.mock.calls.filter(call => String(call[0])
            .includes('keeps retrying')))
            .toHaveLength(1);
        expect(logs.mock.calls.filter(call => String(call[0])
            .includes('passed the gate check')))
            .toHaveLength(1);
        errors.mockRestore();
        logs.mockRestore();
    });

    it('stops the retries when the signal aborts, and keeps the tools off', async () => {
        const spy = gateSpy();
        const attempts: string[] = [];
        const controller = new AbortController();
        const probe: Pick<BrowserControl, 'open'> = {
            open: () => {
                attempts.push('open');
                controller.abort();

                return Promise.reject(new Error('the browser is still starting'));
            },
        };

        await expect(verifyLocalBrowserGate(probe, spy, { signal: controller.signal, attemptsLeft: 0, retryDelayMs: 0 }))
            .resolves.toBe('notVerified');
        expect(attempts)
            .toHaveLength(1);
        expect(spy.enableCount)
            .toBe(0);
    });
});

interface FakeGate {
    port: number | undefined;
    start: () => Promise<void>;
}

// A gate that fails to start on the ports that are busy. The factory records the ports it was asked for.
function fakeGateFactory(busyPorts: number[]): { createGate: (port: number | undefined) => FakeGate; requestedPorts: (number | undefined)[] } {
    const requestedPorts: (number | undefined)[] = [];
    const createGate = (port: number | undefined): FakeGate => {
        requestedPorts.push(port);

        return {
            port,
            start: () => (port !== undefined && busyPorts.includes(port) ? Promise.reject(new Error('listen EADDRINUSE')) : Promise.resolve()),
        };
    };

    return { createGate, requestedPorts };
}

describe('startPlannedGate', () => {
    it('starts a start plan on its planned port when that port is free', async () => {
        const { createGate, requestedPorts } = fakeGateFactory([]);
        const gate = await startPlannedGate(createGate, GATE_PORT, 'start');

        expect(gate?.port)
            .toBe(GATE_PORT);
        expect(requestedPorts)
            .toEqual([GATE_PORT]);
    });

    it('falls back to port 0 for a start plan whose saved port was taken since the plan', async () => {
        const { createGate, requestedPorts } = fakeGateFactory([GATE_PORT]);
        const gate = await startPlannedGate(createGate, GATE_PORT, 'start');

        expect(gate?.port)
            .toBe(0);
        expect(requestedPorts)
            .toEqual([GATE_PORT, 0]);
    });

    it('returns no gate for a reuse plan whose port is taken, so the browser stays off', async () => {
        const { createGate, requestedPorts } = fakeGateFactory([GATE_PORT]);

        await expect(startPlannedGate(createGate, GATE_PORT, 'reuse'))
            .resolves.toBeUndefined();
        expect(requestedPorts)
            .toEqual([GATE_PORT]);
    });

    it('raises the failure for the desktop, which has no port to fall back from', async () => {
        const failingGate = (port: number | undefined): FakeGate => ({ port, start: () => Promise.reject(new Error('listen EADDRINUSE')) });

        await expect(startPlannedGate(failingGate, undefined, 'desktop'))
            .rejects.toThrow('EADDRINUSE');
    });
});

describe('planLocalBrowser', () => {
    it('uses the desktop when there is one, and starts nothing local', async () => {
        const plan = await planLocalBrowser({ hasDesktop: true, hasAgentUser: false, environment: { platform: 'linux', env: {}, exists: () => true }, profileDir: freshProfileDir() });

        expect(plan)
            .toEqual({ kind: 'desktop' });
    });

    it('stays off with no reason shown when an agent user is set', async () => {
        const plan = await planLocalBrowser({ hasDesktop: false, hasAgentUser: true, environment: { platform: 'linux', env: {}, exists: () => true }, profileDir: freshProfileDir() });

        expect(plan)
            .toEqual({ kind: 'off', noBrowserReason: undefined });
    });

    it('starts a new browser on a free gate port when none ran before', async () => {
        const environment = { platform: 'linux' as const, env: { CLOUDBOT_BROWSER_PATH: '/opt/chrome' }, exists: (path: string) => path === '/opt/chrome' };
        const plan = await planLocalBrowser({ hasDesktop: false, hasAgentUser: false, environment, profileDir: freshProfileDir() });

        expect(plan)
            .toEqual({ kind: 'start', browserPath: '/opt/chrome', gatePort: 0 });
    });

    it('says no browser is installed when none is found', async () => {
        const plan = await planLocalBrowser({ hasDesktop: false, hasAgentUser: false, environment: { platform: 'linux', env: {}, exists: () => false }, profileDir: freshProfileDir() });

        expect(plan)
            .toEqual({ kind: 'off', noBrowserReason: 'notInstalled' });
    });
});

describe('localGatePortFor', () => {
    it('gives the gate port of a local plan, and none for the desktop or no browser', () => {
        const start: LocalBrowserPlan = { kind: 'start', browserPath: '/opt/chrome', gatePort: GATE_PORT };
        const reuse: LocalBrowserPlan = { kind: 'reuse', devtoolsPort: 51234, gatePort: GATE_PORT };

        expect(localGatePortFor(start))
            .toBe(GATE_PORT);
        expect(localGatePortFor(reuse))
            .toBe(GATE_PORT);
        expect(localGatePortFor({ kind: 'desktop' }))
            .toBeUndefined();
        expect(localGatePortFor({ kind: 'off', noBrowserReason: 'leftover' }))
            .toBeUndefined();
    });
});

describe('buildLocalBrowserTools', () => {
    it('uses the desktop address for the desktop, with no gate probe', () => {
        const tools = buildLocalBrowserTools({ kind: 'desktop' }, PROFILE);

        expect(tools.browser)
            .toBeDefined();
        expect(tools.gateProbe)
            .toBeUndefined();
        expect(DESKTOP_DEVTOOLS_URL)
            .toBe('http://127.0.0.1:9222');
    });

    it('starts a local browser with its tools off until the gate passes, and a probe that is never off', async () => {
        const tools = buildLocalBrowserTools({ kind: 'start', browserPath: '/opt/chrome', gatePort: 0 }, PROFILE);

        expect(tools.gateProbe)
            .toBeDefined();
        await expect(tools.browser?.open('https://example.com/'))
            .rejects.toThrow('The browser tools are off until the browser passes the gate check');
    });

    it('carries the reason and no browser when the bot has none', () => {
        const tools = buildLocalBrowserTools({ kind: 'off', noBrowserReason: 'leftover' }, PROFILE);

        expect(tools.browser)
            .toBeUndefined();
        expect(tools.noBrowserReason)
            .toBe('leftover');
    });
});

// A profile folder that no earlier run left files in.
function freshProfileDir(): string {
    const profileDir = mkdtempSync(join(tmpdir(), 'cloudbot-profile-'));

    return profileDir;
}
