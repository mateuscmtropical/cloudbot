// These names hold CloudBot's own credentials, such as a sign-in grant or the Bitwarden account. The server reads them
// for its own work. A name the model picks never reads them, so no tool can type them, send them or hand them to a script.
const OAUTH_PREFIX = 'OAUTH_';
const BITWARDEN_PREFIX = 'BITWARDEN_';
const SERVER_ONLY_PREFIXES = [OAUTH_PREFIX, BITWARDEN_PREFIX];

function isServerOnlySecretName(name: string): boolean {
    return SERVER_ONLY_PREFIXES.some(prefix => name.startsWith(prefix));
}

function isBitwardenSecretName(name: string): boolean {
    return name.startsWith(BITWARDEN_PREFIX);
}

export { isBitwardenSecretName, isServerOnlySecretName };
