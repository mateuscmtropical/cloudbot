import { readPublicBaseUrl, readServerHost, readServerPort } from './access/setupLinkUrl.ts';
import { readUploadRetentionMs } from './attachments/cleanUploads.ts';
import { readMaxUploadBytes } from './attachments/saveUpload.ts';
import { readHubConfig } from './people/hubConfig.ts';
import type { HubConfig } from './people/hubConfig.ts';
import { readLocalAcpPaths } from './providers/acpProviders.ts';
import type { AcpProviderId } from './providers/acpProviders.ts';
import { readPushSubject } from './push/readPushSubject.ts';
import { readVoicePrograms } from './voice/transcribeAudio.ts';
import type { VoicePrograms } from './voice/transcribeAudio.ts';
import { readGoogleClientEnv } from '../shared/googleClientEnv.ts';
import type { GoogleClientEnv } from '../shared/googleClientEnv.ts';

// Everything the server takes from its environment. main.ts reads it once at start and passes the parts down.
// A wrong value stops the server at start, with the name of the variable, since each reader throws.
interface ServerConfig {
    port: number;
    host: string;
    version: string;
    nodeEnv: string | undefined;
    dataDir: string;
    agentUser: string | undefined;
    integrationUser: string | undefined;
    claudePath: string | undefined;
    // Only an absolute path, so a relative one never runs from the working folder.
    codexPath: string | undefined;
    desktopCommand: string | undefined;
    galleryRepo: string | undefined;
    publicUrl: string | undefined;
    publicBaseUrl: string;
    hubConfig: HubConfig | undefined;
    googleClient: GoogleClientEnv | undefined;
    pushSubject: string;
    localAcpPaths: Partial<Record<AcpProviderId, string>>;
    voicePrograms: VoicePrograms;
    maxUploadBytes: number;
    uploadRetentionMs: number;
}

const DEFAULT_DATA_DIR = './data';

function readServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
    const configuredDataDir = env.CLOUDBOT_DATA_DIR ?? '';
    const codexPath = env.CODEX_PATH?.startsWith('/') === true ? env.CODEX_PATH : undefined;

    return {
        port: readServerPort(env),
        host: readServerHost(env),
        version: env.CLOUDBOT_VERSION ?? 'dev',
        nodeEnv: env.NODE_ENV,
        dataDir: configuredDataDir === '' ? DEFAULT_DATA_DIR : configuredDataDir,
        agentUser: env.CLOUDBOT_AGENT_USER,
        integrationUser: env.CLOUDBOT_INTEGRATION_USER,
        claudePath: env.CLAUDE_PATH,
        codexPath,
        desktopCommand: env.CLOUDBOT_DESKTOP_COMMAND,
        galleryRepo: env.CLOUDBOT_GALLERY_REPO,
        publicUrl: env.CLOUDBOT_PUBLIC_URL,
        publicBaseUrl: readPublicBaseUrl(env),
        hubConfig: readHubConfig(env),
        googleClient: readGoogleClientEnv(env),
        pushSubject: readPushSubject(env),
        localAcpPaths: readLocalAcpPaths(env),
        voicePrograms: readVoicePrograms(env),
        maxUploadBytes: readMaxUploadBytes(env),
        uploadRetentionMs: readUploadRetentionMs(env),
    };
}

export { readServerConfig };
export type { ServerConfig };
