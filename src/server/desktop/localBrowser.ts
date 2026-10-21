import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { join, resolve as resolvePath, win32 } from 'node:path';

import { BrowserControl, BrowserError, DESKTOP_DEVTOOLS_URL, GATE_REFUSED_ERROR, devtoolsSocketUrl } from './BrowserControl.ts';
import { CdpConnection } from './CdpConnection.ts';
import type { DesktopCommand } from './DesktopSupervisor.ts';

interface LocalBrowserEnvironment {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    exists: (path: string) => boolean;
}

interface LocalBrowserArgumentsOptions {
    profileDir: string;
    // The port of the browser gate this server listens on.
    gatePort: number;
}

// The body of a DevTools answer, or undefined when it is larger than the cap.
interface VersionAnswer {
    readBody: () => Promise<string | undefined>;
}

// Asks a DevTools port for its version. Tests pass a fake.
type VersionProbe = (url: string, signal: AbortSignal) => Promise<VersionAnswer>;

interface ReuseDependencies {
    readText: (path: string) => string | undefined;
    removeFile: (path: string) => void;
    probe: VersionProbe;
    // Asks the browser for its command line over DevTools. Tests pass a fake.
    readCommandLine: (socketUrl: string) => Promise<string>;
}

interface FreeProfile {
    status: 'free';
}

interface ReusableProfile {
    status: 'reusable';
    port: number;
    gatePort: number;
}

interface LeftoverProfile {
    status: 'leftover';
}

type ProfileBrowserState = FreeProfile | ReusableProfile | LeftoverProfile;

type NoBrowserReason = 'notInstalled' | 'leftover';

interface LocalBrowserPlanInput {
    hasDesktop: boolean;
    hasAgentUser: boolean;
    environment: LocalBrowserEnvironment;
    profileDir: string;
}

interface DesktopPlan {
    kind: 'desktop';
}

interface OffPlan {
    kind: 'off';
    noBrowserReason: NoBrowserReason | undefined;
}

interface StartPlan {
    kind: 'start';
    browserPath: string;
    gatePort: number;
}

interface ReusePlan {
    kind: 'reuse';
    devtoolsPort: number;
    gatePort: number;
}

type LocalBrowserPlan = DesktopPlan | OffPlan | StartPlan | ReusePlan;

interface LocalBrowserTools {
    // The browser the tools use. Undefined when the bot has no browser.
    browser: BrowserControl | undefined;
    // A control that is never disabled, used only for the gate check of a local browser.
    gateProbe: BrowserControl | undefined;
    noBrowserReason: NoBrowserReason | undefined;
}

const BROWSER_PROFILE_FOLDER = 'browser-profile';
const BROWSER_PATH_VARIABLE = 'CLOUDBOT_BROWSER_PATH';
// Chrome writes this file in the profile while DevTools is on. Its first line is the port, its second the socket path.
const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';
// The gate port of the last run. A browser that is reused still points its proxy at that port.
const GATE_PORT_FILE = 'cloudbot-gate-port';
const PROBE_TIMEOUT_MS = 2000;
const IDENTITY_TIMEOUT_MS = 2000;
const MAX_VERSION_BYTES = 64 * 1024;
const BROWSER_NAME_PATTERN = /^(Chrome|Chromium|Edg)\//;
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const LOOPBACK_HOST = '127.0.0.1';
const GATE_NOT_VERIFIED_MESSAGE = 'The browser tools are off until the browser passes the gate check. Tell the owner if this lasts.';

// The same flags as docker/cloudbot-desktop, so the local browser has the same gate and the same DevTools rules.
// The bypass list without loopback sends loopback through the gate, which refuses it.
// Port 0 lets Chrome pick a free port. It writes the port to DevToolsActivePort in the profile.
function buildLocalBrowserArguments(options: LocalBrowserArgumentsOptions): string[] {
    return [
        '--remote-debugging-port=0',
        `--remote-debugging-address=${LOOPBACK_HOST}`,
        `--user-data-dir=${options.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        // QUIC would carry requests over UDP, past the SOCKS gate.
        '--disable-quic',
        `--window-size=${String(WINDOW_WIDTH)},${String(WINDOW_HEIGHT)}`,
        `--proxy-server=socks5://${LOOPBACK_HOST}:${String(options.gatePort)}`,
        '--proxy-bypass-list=<-loopback>',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        // Without these, Windows reports a window that another window covers as hidden, and Chrome then sends no
        // screencast frames to the Screen panel.
        '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
        '--disable-backgrounding-occluded-windows',
        'about:blank',
    ];
}

// Installed Chrome, Chromium or Edge, in the usual install paths of each system. The first one found wins.
function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
    if (platform === 'win32') {
        // win32.join keeps backslashes, so the paths are right on any system that runs the tests.
        const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
        const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
        const localAppData = env.LOCALAPPDATA ?? '';

        return [
            win32.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            win32.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            win32.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            win32.join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
            win32.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            win32.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ];
    }

    if (platform === 'darwin') {
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ];
    }

    return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
    ];
}

// CLOUDBOT_BROWSER_PATH, when it is an absolute path that exists, wins over the install paths.
function findLocalBrowser(environment: LocalBrowserEnvironment): string | undefined {
    const configuredPath = environment.env[BROWSER_PATH_VARIABLE] ?? '';
    const candidates = configuredPath === ''
        ? browserCandidates(environment.platform, environment.env)
        : [configuredPath];

    return candidates.find(candidate => environment.exists(candidate));
}

// The profile is a folder of the bot's own under the data folder. It is never the owner's profile.
// Chrome creates the folder on its first start.
function localBrowserProfileDir(dataDir: string): string {
    return join(dataDir, BROWSER_PROFILE_FOLDER);
}

// A port number from the first line of a file, or undefined.
function parsePort(text: string | undefined): number | undefined {
    const firstLine = (text ?? '').split('\n')[0] ?? '';
    const trimmedLine = firstLine.trim();
    const port = Number(trimmedLine);

    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function readTextFile(filePath: string): string | undefined {
    try {
        return readFileSync(filePath, 'utf8');
    } catch {
        return undefined;
    }
}

// The DevTools port the browser of this profile wrote, or undefined. It is read on each browser action,
// so a browser that restarts on another port is found.
function readDevtoolsPort(profileDir: string): number | undefined {
    const portFilePath = join(profileDir, DEVTOOLS_PORT_FILE);
    const portFileText = readTextFile(portFilePath);

    return parsePort(portFileText);
}

function readSavedGatePort(profileDir: string): number | undefined {
    const gateFilePath = join(profileDir, GATE_PORT_FILE);
    const gateText = readTextFile(gateFilePath);

    return parsePort(gateText);
}

function readField(value: unknown, field: string): unknown {
    return typeof value === 'object' && value !== null ? Reflect.get(value, field) : undefined;
}

function parseJsonText(text: string): unknown {
    try {
        const parsed: unknown = JSON.parse(text);

        return parsed;
    } catch {
        return undefined;
    }
}

// Reads the body in chunks and gives up above the cap, so a hostile answer cannot fill the memory.
async function readCappedBody(reader: ReadableStreamDefaultReader<Uint8Array>, chunks: Uint8Array[], total: number): Promise<string | undefined> {
    const chunk = await reader.read();

    if (chunk.done) {
        const joined = Buffer.concat(chunks);

        return joined.toString('utf8');
    }

    const nextTotal = total + chunk.value.byteLength;

    if (nextTotal > MAX_VERSION_BYTES) {
        await reader.cancel();

        return undefined;
    }

    return readCappedBody(reader, [...chunks, chunk.value], nextTotal);
}

// The body of a DevTools answer, read up to the cap.
function answerFromResponse(response: Response): VersionAnswer {
    const body = response.body;

    return {
        readBody: () => {
            if (body === null) {
                return Promise.resolve(undefined);
            }

            const reader = body.getReader();

            return readCappedBody(reader, [], 0);
        },
    };
}

async function probeVersion(url: string, signal: AbortSignal): Promise<VersionAnswer> {
    // A redirect could lead the probe off loopback, so it is an error.
    const response = await fetch(url, { signal, redirect: 'error' });

    return answerFromResponse(response);
}

// Asks the browser for its command line. The socket is the browser's own, on loopback, checked by devtoolsSocketUrl.
// Browser.getBrowserCommandLine needs --enable-automation, which the bot must not set, so SystemInfo answers instead.
async function readBrowserCommandLine(socketUrl: string): Promise<string> {
    const connection = await CdpConnection.open(socketUrl, undefined, IDENTITY_TIMEOUT_MS);

    try {
        const result = await connection.call('SystemInfo.getInfo', {}, IDENTITY_TIMEOUT_MS);
        const commandLine = readField(result, 'commandLine');

        return typeof commandLine === 'string' ? commandLine : '';
    } finally {
        connection.close();
    }
}

function defaultReuseDependencies(): ReuseDependencies {
    return {
        readText: readTextFile,
        removeFile: (filePath) => {
            rmSync(filePath, { force: true });
        },
        probe: probeVersion,
        readCommandLine: readBrowserCommandLine,
    };
}

function normalizeProfilePath(path: string): string {
    const resolved = resolvePath(path);

    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// True when the command line names this profile as --user-data-dir=<path>, quoted when the path has spaces.
function commandLineNamesProfile(commandLine: string, profileDir: string): boolean {
    const match = /--user-data-dir=(?:"([^"]*)"|(\S+))/.exec(commandLine);
    const givenPath = match?.[1] ?? match?.[2];

    if (givenPath === undefined) {
        return false;
    }

    return normalizeProfilePath(givenPath) === normalizeProfilePath(profileDir);
}

// True when the command line routes this browser through the gate on the given port. The port must end there.
function commandLineNamesGate(commandLine: string, gatePort: number): boolean {
    const gatePattern = new RegExp(`--proxy-server=socks5://127\\.0\\.0\\.1:${String(gatePort)}(?!\\d)`);

    return gatePattern.test(commandLine);
}

// The socket path must be the one in the port file, and the command line must name this profile and this gate.
// Any other identity, or a missing one, counts as a browser that is not ours.
async function isOwnBrowser(parsedBody: unknown, portFileText: string, port: number, profileDir: string, gatePort: number, dependencies: ReuseDependencies): Promise<boolean> {
    const rawSocketUrl = readField(parsedBody, 'webSocketDebuggerUrl');
    const portText = String(port);
    const socketUrl = devtoolsSocketUrl(rawSocketUrl, portText);

    if (socketUrl === undefined) {
        return false;
    }

    const fileSocketPath = (portFileText.split('\n')[1] ?? '').trim();
    const socketPath = new URL(socketUrl).pathname;

    if (fileSocketPath !== socketPath) {
        return false;
    }

    const commandLine = await dependencies.readCommandLine(socketUrl);

    return commandLineNamesProfile(commandLine, profileDir) && commandLineNamesGate(commandLine, gatePort);
}

// A refused connection means nothing listens on the port, so the file is stale and is removed.
// Any other failure, or a browser that does not identify, means something may still hold the profile.
// Such a profile is left alone, and the browser tools stay off.
function isConnectionRefused(error: unknown): boolean {
    const cause = error instanceof Error ? error.cause : undefined;

    return readField(cause, 'code') === 'ECONNREFUSED';
}

// Tells a browser of this profile that can be reused from a leftover one, or a profile that is free to start on.
// The reusable state needs the gate port the browser was started with, so the caller passes the saved one when it is free.
async function inspectProfileBrowser(profileDir: string, savedGatePort: number | undefined, dependencies: ReuseDependencies = defaultReuseDependencies()): Promise<ProfileBrowserState> {
    const portFilePath = join(profileDir, DEVTOOLS_PORT_FILE);
    const portFileText = dependencies.readText(portFilePath);
    const port = parsePort(portFileText);

    if (port === undefined || portFileText === undefined) {
        if (portFileText !== undefined) {
            dependencies.removeFile(portFilePath);
        }

        return { status: 'free' };
    }

    const versionUrl = `http://${LOOPBACK_HOST}:${String(port)}/json/version`;
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    let answer: VersionAnswer;

    try {
        answer = await dependencies.probe(versionUrl, signal);
    } catch (error: unknown) {
        if (isConnectionRefused(error)) {
            dependencies.removeFile(portFilePath);

            return { status: 'free' };
        }

        return { status: 'leftover' };
    }

    let body: string | undefined;

    try {
        body = await answer.readBody();
    } catch {
        return { status: 'leftover' };
    }

    const parsedBody: unknown = body === undefined ? undefined : parseJsonText(body);
    const browserName = readField(parsedBody, 'Browser');

    // Something answers on the port, but it is not Chrome or Edge, so the file of the old browser is stale.
    if (typeof browserName !== 'string' || !BROWSER_NAME_PATTERN.test(browserName)) {
        dependencies.removeFile(portFilePath);

        return { status: 'free' };
    }

    if (savedGatePort === undefined) {
        return { status: 'leftover' };
    }

    try {
        const isOwn = await isOwnBrowser(parsedBody, portFileText, port, profileDir, savedGatePort, dependencies);

        return isOwn ? { status: 'reusable', port, gatePort: savedGatePort } : { status: 'leftover' };
    } catch {
        return { status: 'leftover' };
    }
}

// True when nothing listens on the port now.
function isLoopbackPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = createServer();

        probe.once('error', () => {
            resolve(false);
        });
        probe.listen(port, LOOPBACK_HOST, () => {
            probe.close(() => {
                resolve(true);
            });
        });
    });
}

// Written once the gate listens, so the next run can reuse its port.
function saveLocalGatePort(profileDir: string, gatePort: number): void {
    mkdirSync(profileDir, { recursive: true });

    const gateFilePath = join(profileDir, GATE_PORT_FILE);
    const gateText = String(gatePort);

    writeFileSync(gateFilePath, gateText);
}

// Decides how the local browser is used: the desktop, none at all, a new browser, or the one a crash left running.
// A browser that is open but cannot be identified as ours is left alone, and nothing new starts on its profile.
async function planLocalBrowser(input: LocalBrowserPlanInput): Promise<LocalBrowserPlan> {
    if (input.hasDesktop) {
        return { kind: 'desktop' };
    }

    if (input.hasAgentUser) {
        console.log('The local browser stays off, because CLOUDBOT_AGENT_USER is set. A browser here would run as the server user.');

        return { kind: 'off', noBrowserReason: undefined };
    }

    // The gate uses the saved port when nothing else holds it, so a reused browser's proxy still works.
    const savedGatePort = readSavedGatePort(input.profileDir);
    const isSavedGateFree = savedGatePort !== undefined && await isLoopbackPortFree(savedGatePort);
    const freeSavedGatePort = isSavedGateFree ? savedGatePort : undefined;
    const state = await inspectProfileBrowser(input.profileDir, freeSavedGatePort);

    if (state.status === 'leftover') {
        console.log('A browser from the last run is still open on this profile, so the browser tools stay off. Close that CloudBot browser window and restart CloudBot.');

        return { kind: 'off', noBrowserReason: 'leftover' };
    }

    if (state.status === 'reusable') {
        console.log('Reusing the browser left open from the last run.');

        return { kind: 'reuse', devtoolsPort: state.port, gatePort: state.gatePort };
    }

    const browserPath = findLocalBrowser(input.environment);

    if (browserPath === undefined) {
        console.log('No browser found, so the bot cannot browse. Install Chrome, Chromium or Edge, or set CLOUDBOT_BROWSER_PATH to one.');

        return { kind: 'off', noBrowserReason: 'notInstalled' };
    }

    // Port 0 lets the OS pick a free port when the saved one is taken.
    const startGatePort = freeSavedGatePort ?? 0;

    return { kind: 'start', browserPath, gatePort: startGatePort };
}

// The gate port the server must listen on for a plan, or undefined when the plan has no local gate.
function localGatePortFor(plan: LocalBrowserPlan): number | undefined {
    if (plan.kind === 'start' || plan.kind === 'reuse') {
        return plan.gatePort;
    }

    return undefined;
}

// The browser tools for a plan. A local browser starts disabled, until it passes the gate check.
// The gate probe is a separate control that is never disabled, since the check must navigate while the tools are off.
function buildLocalBrowserTools(plan: LocalBrowserPlan, profileDir: string): LocalBrowserTools {
    if (plan.kind === 'desktop') {
        return { browser: new BrowserControl({ devtoolsUrl: DESKTOP_DEVTOOLS_URL }), gateProbe: undefined, noBrowserReason: undefined };
    }

    if (plan.kind === 'off') {
        return { browser: undefined, gateProbe: undefined, noBrowserReason: plan.noBrowserReason };
    }

    // Local Chrome writes its DevTools port into the profile, so the port is read on each action.
    const devtoolsUrl = (): string | undefined => {
        const port = readDevtoolsPort(profileDir);

        return port === undefined ? undefined : `http://${LOOPBACK_HOST}:${String(port)}`;
    };
    const browser = new BrowserControl({ devtoolsUrl });
    const gateProbe = new BrowserControl({ devtoolsUrl });

    browser.disable(GATE_NOT_VERIFIED_MESSAGE);

    return { browser, gateProbe, noBrowserReason: undefined };
}

// Only what Chrome needs to start on each system. The server's own variables, such as the owner's secrets, stay out.
// Proxy and API variables stay out too, so the browser cannot reach the bot's model keys.
const BROWSER_ENVIRONMENT_KEYS = [
    'PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA',
    'ProgramData', 'windir', 'USERNAME', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'LANG',
];

function minimalBrowserEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const kept: NodeJS.ProcessEnv = {};

    BROWSER_ENVIRONMENT_KEYS.forEach((key) => {
        const value = environment[key];

        if (value !== undefined) {
            kept[key] = value;
        }
    });

    return kept;
}

function readModifiedTime(filePath: string): number | undefined {
    try {
        return statSync(filePath).mtimeMs;
    } catch {
        return undefined;
    }
}

// The port file is removed when the browser this server started exits. It is removed only when this browser wrote it,
// so a browser that handed the profile to another process cannot delete the file of that process.
function createLocalBrowserSpawn(profileDir: string, environment: NodeJS.ProcessEnv): (command: string, args: string[]) => ChildProcess {
    return (command, args) => {
        const portFilePath = join(profileDir, DEVTOOLS_PORT_FILE);
        const startedAt = Date.now();
        const child = spawn(command, args, { env: minimalBrowserEnvironment(environment), stdio: ['ignore', 'ignore', 'pipe'], shell: false });

        child.once('exit', () => {
            const writtenAt = readModifiedTime(portFilePath);

            if (writtenAt !== undefined && writtenAt >= startedAt) {
                rmSync(portFilePath, { force: true });
            }
        });

        return child;
    };
}

// The gate gives the browser one way out. A throwaway listener on loopback is the target. If a connection reaches
// it, the browser bypassed the gate. The gate's own refusal, and no connection, is the only pass.
const GATE_CHECK_ATTEMPTS = 40;
const GATE_CHECK_WAIT_MS = 500;
const GATE_RETRY_MS = 30_000;
const GATE_REFUSED_PREFIX = 'The page could not be opened';
const GATE_BYPASS_MESSAGE = 'The browser tools are off, because the browser reached a private address. Tell the owner.';
const BYPASS_ANSWER = 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

type GateCheckResult = 'passed' | 'bypassed' | 'notVerified';

interface GateVerifyOptions {
    // Aborts the retries, such as when the server closes.
    signal: AbortSignal;
    retryDelayMs?: number;
    attemptsLeft?: number;
}

// A gate that can be started. BrowserGate is one.
interface StartableGate {
    start: () => Promise<void>;
}

type GateAttempt = 'passed' | 'bypassed' | 'retry';

interface ConnectionCounter {
    count: number;
}

interface ThrowawayListener {
    server: Server;
    port: number;
}

function startThrowawayListener(counter: ConnectionCounter): Promise<ThrowawayListener> {
    return new Promise((resolve, reject) => {
        const server = createServer((socket) => {
            counter.count += 1;
            socket.end(BYPASS_ANSWER);
        });

        server.once('error', reject);
        server.listen(0, LOOPBACK_HOST, () => {
            const address = server.address();

            if (typeof address === 'object' && address !== null) {
                resolve({ server, port: address.port });

                return;
            }

            reject(new Error('The gate check could not get a port.'));
        });
    });
}

function isGateRefusal(error: unknown): boolean {
    return error instanceof BrowserError
        && error.message.startsWith(GATE_REFUSED_PREFIX)
        && error.message.includes(GATE_REFUSED_ERROR);
}

async function attemptGateCheck(probe: Pick<BrowserControl, 'open'>): Promise<GateAttempt> {
    const counter: ConnectionCounter = { count: 0 };
    const listener = await startThrowawayListener(counter);
    const targetUrl = `http://${LOOPBACK_HOST}:${String(listener.port)}/`;

    try {
        await probe.open(targetUrl);

        return counter.count > 0 ? 'bypassed' : 'retry';
    } catch (error: unknown) {
        if (counter.count > 0) {
            return 'bypassed';
        }

        return isGateRefusal(error) ? 'passed' : 'retry';
    } finally {
        listener.server.close();
    }
}

async function checkLocalBrowserGate(probe: Pick<BrowserControl, 'open'>, attemptsLeft = GATE_CHECK_ATTEMPTS): Promise<GateCheckResult> {
    const attempt = await attemptGateCheck(probe);

    if (attempt === 'passed' || attempt === 'bypassed') {
        return attempt;
    }

    if (attemptsLeft === 0) {
        return 'notVerified';
    }

    await new Promise((resolve) => {
        setTimeout(resolve, GATE_CHECK_WAIT_MS);
    });

    return checkLocalBrowserGate(probe, attemptsLeft - 1);
}

// A check that cannot run, such as a listener that fails to start, is not a pass.
async function checkGateSafely(probe: Pick<BrowserControl, 'open'>, attemptsLeft: number): Promise<GateCheckResult> {
    try {
        return await checkLocalBrowserGate(probe, attemptsLeft);
    } catch {
        return 'notVerified';
    }
}

// Waits, or returns early when the signal aborts. The timer does not keep the process alive.
function pauseUnlessAborted(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            resolve();
        }, delayMs);

        timer.unref();
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

// Run after the browser starts or is reused. The browser tools stay off until the check passes. A bypass keeps them off.
// A check that does not pass in time is run again every retry delay, until it passes, bypasses, or the signal aborts.
// Applies a decided check: a pass enables the tools, a bypass keeps them off for good.
function applyGateResult(result: GateCheckResult, browser: Pick<BrowserControl, 'enable' | 'disable'>): void {
    if (result === 'passed') {
        browser.enable();
    }

    if (result === 'bypassed') {
        browser.disable(GATE_BYPASS_MESSAGE);
        console.error('The local browser reached a private address, so a browser policy bypasses the gate. The browser tools stay off.');
    }
}

// Runs the check again after each delay, until it decides or the signal aborts. An abort reports not verified.
async function retryGateUntilDecided(probe: Pick<BrowserControl, 'open'>, options: GateVerifyOptions): Promise<GateCheckResult> {
    const { signal, retryDelayMs = GATE_RETRY_MS, attemptsLeft = GATE_CHECK_ATTEMPTS } = options;

    await pauseUnlessAborted(retryDelayMs, signal);

    if (signal.aborted) {
        return 'notVerified';
    }

    const result = await checkGateSafely(probe, attemptsLeft);

    if (result === 'notVerified') {
        return retryGateUntilDecided(probe, options);
    }

    return result;
}

// Run after the browser starts or is reused. The browser tools stay off until the check passes. A bypass keeps them off.
// A check that does not pass in time is run again every retry delay. The retries are logged once, with the outcome.
async function verifyLocalBrowserGate(probe: Pick<BrowserControl, 'open'>, browser: Pick<BrowserControl, 'enable' | 'disable'>, options: GateVerifyOptions): Promise<GateCheckResult> {
    const attemptsLeft = options.attemptsLeft ?? GATE_CHECK_ATTEMPTS;
    const firstResult = await checkGateSafely(probe, attemptsLeft);

    if (firstResult !== 'notVerified') {
        applyGateResult(firstResult, browser);

        return firstResult;
    }

    console.error('The local browser did not pass the gate check yet. The browser tools stay off, and the check keeps retrying.');

    const result = await retryGateUntilDecided(probe, options);

    applyGateResult(result, browser);

    if (result === 'passed') {
        console.log('The local browser passed the gate check. The browser tools are on.');
    }

    return result;
}

// Starts the gate on the port of the plan. The plan kind decides what a busy port means:
// - a start plan falls back to port 0, since its port was taken since the plan;
// - a reuse plan cannot run its browser without its port, so it returns no gate and the browser tools stay off;
// - the desktop and a plan without a local gate have no fallback, so their failure is raised.
async function startPlannedGate<Gate extends StartableGate>(createGate: (port: number | undefined) => Gate, plannedPort: number | undefined, planKind: LocalBrowserPlan['kind']): Promise<Gate | undefined> {
    const gate = createGate(plannedPort);

    try {
        await gate.start();

        return gate;
    } catch (error: unknown) {
        if (planKind === 'reuse') {
            console.error('The gate port of the browser left open from the last run is taken, so the browser tools stay off. Close the process that holds that port, and restart CloudBot.');

            return undefined;
        }

        const canFallBack = planKind === 'start' && plannedPort !== undefined && plannedPort !== 0;

        if (!canFallBack) {
            throw error;
        }

        const fallbackGate = createGate(0);

        await fallbackGate.start();

        return fallbackGate;
    }
}

function buildLocalBrowserCommand(browserPath: string, options: LocalBrowserArgumentsOptions): DesktopCommand {
    return { command: browserPath, args: buildLocalBrowserArguments(options) };
}

function defaultLocalBrowserEnvironment(): LocalBrowserEnvironment {
    return { platform: process.platform, env: process.env, exists: existsSync };
}

export { BROWSER_PATH_VARIABLE, GATE_NOT_VERIFIED_MESSAGE, answerFromResponse, buildLocalBrowserArguments, buildLocalBrowserCommand, buildLocalBrowserTools, checkLocalBrowserGate, commandLineNamesGate, createLocalBrowserSpawn, defaultLocalBrowserEnvironment, findLocalBrowser, inspectProfileBrowser, localBrowserProfileDir, localGatePortFor, minimalBrowserEnvironment, parsePort, planLocalBrowser, readDevtoolsPort, saveLocalGatePort, startPlannedGate, verifyLocalBrowserGate };
export type { GateCheckResult, GateVerifyOptions, LocalBrowserArgumentsOptions, StartableGate, LocalBrowserEnvironment, LocalBrowserPlan, LocalBrowserTools, NoBrowserReason, ProfileBrowserState, ReuseDependencies, VersionAnswer, VersionProbe };
