import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { McpServerConfig } from '../agent/AgentRunner.ts';
import { DesktopSupervisor } from '../desktop/DesktopSupervisor.ts';
import type { DesktopSpawnFunction } from '../desktop/DesktopSupervisor.ts';

// The image installs the binary here. It is root-owned, so the bot user cannot replace it.
const AI_MEMORY_BINARY_PATH = '/usr/local/bin/ai-memory';
const AI_MEMORY_FOLDER_NAME = 'ai-memory';
// A fixed loopback port, so every turn's MCP config can name it. The bot user shares the network of the container.
const AI_MEMORY_PORT = 9226;
const AI_MEMORY_HOST = '127.0.0.1';
const AI_MEMORY_PATH = '/usr/local/bin:/usr/bin:/bin';
const PROBE_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 1_000;
// A standard initialize request. The probe only checks that the server answers it.
const INITIALIZE_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cloudbot', version: '1.0.0' } } });

type ProbeFunction = (url: string) => Promise<boolean>;

interface AiMemoryServiceOptions {
    binaryPath: string;
    // The folder of the store and the config. Only the server user writes there.
    folder: string;
    port?: number | undefined;
    // Tests inject fakes here. Production spawns the binary.
    spawnFunction?: DesktopSpawnFunction | undefined;
    probe?: ProbeFunction | undefined;
    log?: ((message: string) => void) | undefined;
}

function memoryUrl(port: number): string {
    return `http://${AI_MEMORY_HOST}:${String(port)}/mcp`;
}

// The global flags come before serve, as the upstream systemd unit writes them. The server listens on loopback only.
function buildAiMemoryArguments(folder: string, configPath: string, port: number): string[] {
    return ['--data-dir', folder, '--config', configPath, 'serve', '--transport', 'http', '--bind', `${AI_MEMORY_HOST}:${String(port)}`];
}

// Local embeddings download a model on the first start. The bots do not need it, so the server stays offline.
function renderAiMemoryConfig(): string {
    return 'embedding_provider = "none"\n';
}

// The server gets only HOME and PATH. HOME is its own folder, so nothing it writes outside the store lands in the server home.
function spawnAiMemory(folder: string): DesktopSpawnFunction {
    return (command, args) => spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false, env: { HOME: folder, PATH: AI_MEMORY_PATH } });
}

// The mode of mkdir and writeFile applies only when the item is made, so an existing one is set again.
function prepareFolder(folder: string, configPath: string): void {
    const configText = renderAiMemoryConfig();

    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    writeFileSync(configPath, configText, { mode: 0o600 });
    chmodSync(configPath, 0o600);
}

// Any answer to the initialize request means the store is open and the server listens. No answer means it is not up yet.
async function probeAiMemory(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
            body: INITIALIZE_BODY,
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const isUp = response.ok;

        // A stream answer may never end, so its body is dropped rather than read.
        await response.body?.cancel();

        return isUp;
    } catch {
        // No answer is the normal state before the server starts, so it is not an error.
        return false;
    }
}

// Runs the memory server beside the server process. The restart loop is the one the desktop uses. A turn gets the server
// only after it answers, so no turn waits for it.
class AiMemoryService {
    private readonly url: string;
    private readonly probe: ProbeFunction;
    private readonly spawnFunction: DesktopSpawnFunction;
    private readonly supervisor: DesktopSupervisor;
    private readonly folder: string;
    private readonly configPath: string;
    private readonly log: (message: string) => void;
    private child: ChildProcess | undefined;
    private pollTimer: NodeJS.Timeout | undefined;
    private isListening = false;

    constructor(options: AiMemoryServiceOptions) {
        const port = options.port ?? AI_MEMORY_PORT;
        const configPath = join(options.folder, 'config.toml');

        this.folder = options.folder;
        this.configPath = configPath;
        this.url = memoryUrl(port);
        this.probe = options.probe ?? probeAiMemory;
        this.spawnFunction = options.spawnFunction ?? spawnAiMemory(options.folder);
        this.log = options.log ?? console.error;
        this.supervisor = new DesktopSupervisor({
            label: 'ai-memory',
            desktopCommand: { command: options.binaryPath, args: buildAiMemoryArguments(options.folder, configPath, port) },
            spawnFunction: (command, args) => this.spawnServer(command, args),
            log: this.log,
        });
    }

    start(): void {
        try {
            prepareFolder(this.folder, this.configPath);
        } catch {
            this.log('Could not prepare the ai-memory folder, so ai-memory stays off.');

            return;
        }

        this.supervisor.start();
    }

    stop(): void {
        this.supervisor.stop();
        this.child = undefined;
        this.isListening = false;

        if (this.pollTimer !== undefined) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    // The entry for a turn's MCP config, or undefined while the server does not answer.
    serverConfig(): McpServerConfig | undefined {
        return this.isListening ? { type: 'http', url: this.url } : undefined;
    }

    private spawnServer(command: string, args: string[]): ChildProcess {
        const child = this.spawnFunction(command, args);

        this.child = child;
        this.isListening = false;
        child.once('exit', () => {
            // A child that was already replaced or stopped leaves the state to the newer one.
            if (this.child === child) {
                this.child = undefined;
                this.isListening = false;
            }
        });
        this.pollUntilListening(child);

        return child;
    }

    // Asks the server each interval until it answers. A child that exited or was replaced is not asked again.
    private pollUntilListening(child: ChildProcess): void {
        void this.probe(this.url)
            .then((isUp) => {
                if (this.child !== child) {
                    return;
                }

                if (isUp) {
                    this.isListening = true;

                    return;
                }

                this.pollTimer = setTimeout(() => {
                    this.pollUntilListening(child);
                }, PROBE_INTERVAL_MS);
                this.pollTimer.unref();
            });
    }
}

// Returns undefined when the switch is off or the image has no binary, so the turns stay as they were before memory.
function createAiMemoryService(options: { isEnabled: boolean; dataDir: string; binaryPath?: string | undefined; binaryExists?: ((path: string) => boolean) | undefined }): AiMemoryService | undefined {
    if (!options.isEnabled) {
        return undefined;
    }

    const binaryPath = options.binaryPath ?? AI_MEMORY_BINARY_PATH;
    const hasBinary = (options.binaryExists ?? existsSync)(binaryPath);

    if (!hasBinary) {
        console.warn(`ai-memory is off, because ${binaryPath} is not installed.`);

        return undefined;
    }

    const folder = join(options.dataDir, AI_MEMORY_FOLDER_NAME);

    return new AiMemoryService({ binaryPath, folder });
}

export { AI_MEMORY_BINARY_PATH, AI_MEMORY_PORT, AiMemoryService, buildAiMemoryArguments, createAiMemoryService, renderAiMemoryConfig };
export type { AiMemoryServiceOptions, ProbeFunction };
