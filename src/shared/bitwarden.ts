// What the owner's page may know about the saved Bitwarden account. No secret ever leaves the vault.
interface BitwardenStatus {
    configured: boolean;
    // The Bitwarden server the account signs in to. It is empty when nothing is saved.
    serverUrl: string;
}

// The answer to the connection test. The error is a plain sentence that never holds a secret.
interface BitwardenTestResult {
    ok: boolean;
    error?: string;
}

const DEFAULT_BITWARDEN_SERVER_URL = 'https://vault.bitwarden.com';

export { DEFAULT_BITWARDEN_SERVER_URL };
export type { BitwardenStatus, BitwardenTestResult };
