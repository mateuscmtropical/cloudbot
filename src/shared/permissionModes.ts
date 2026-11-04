// How freely a bot runs its tools, chosen by the owner for each bot. See "What asks and what does not" in docs/ARCHITECTURE.md.
const PERMISSION_MODES = ['ask', 'auto', 'yolo'] as const;

type PermissionMode = (typeof PERMISSION_MODES)[number];

function isPermissionMode(value: unknown): value is PermissionMode {
    return PERMISSION_MODES.some(mode => mode === value);
}

// A stored value that is not known any more reads as the mode that asks.
function readPermissionMode(value: unknown): PermissionMode {
    return isPermissionMode(value) ? value : 'ask';
}

export { PERMISSION_MODES, isPermissionMode, readPermissionMode };
export type { PermissionMode };
