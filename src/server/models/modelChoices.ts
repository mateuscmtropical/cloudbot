// The aliases the SDK takes in its model option. The list follows the comment on AgentDefinition.model
// in node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts.
const MODEL_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku'];
// Full model ids start with "claude-". The pattern keeps any other text away from the CLI.
const MODEL_ID_PATTERN = /^claude-[a-z0-9.-]+$/;
const MAX_MODEL_LENGTH = 100;
// The first three kinds pick the model of a turn. browsing and documents are helper agents, and a null
// choice for either one means the bot has no helper for that work.
const MODEL_KINDS = ['chat', 'routines', 'review', 'browsing', 'documents'] as const;

type ModelKind = (typeof MODEL_KINDS)[number];

// A null choice means the CLI default model, or no helper for browsing and documents.
interface ModelChoices {
    chat: string | null;
    routines: string | null;
    review: string | null;
    browsing: string | null;
    documents: string | null;
}

interface ModelInputError {
    error: string;
}

const INVALID_BODY: ModelInputError = { error: 'Send an object with the chat, routines, review, browsing and documents models.' };

function isValidModel(value: string): boolean {
    if (value.length > MAX_MODEL_LENGTH) {
        return false;
    }

    return MODEL_ALIASES.includes(value) || MODEL_ID_PATTERN.test(value);
}

function isValidChoice(value: unknown): boolean {
    if (value === undefined || value === null) {
        return true;
    }

    return typeof value === 'string' && isValidModel(value);
}

function toChoice(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

// A missing or null field means the CLI default, so a PUT with no fields clears every choice.
function parseModelInput(payload: unknown): ModelChoices | ModelInputError {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return INVALID_BODY;
    }

    const fields = payload as Record<string, unknown>;
    const invalidKinds: ModelKind[] = MODEL_KINDS.filter(kind => !isValidChoice(fields[kind]));
    const firstInvalidKind = invalidKinds[0];

    if (firstInvalidKind !== undefined) {
        return { error: `The ${firstInvalidKind} model must be null, an alias such as haiku or sonnet, or a full model id that starts with claude-.` };
    }

    return {
        chat: toChoice(fields.chat),
        routines: toChoice(fields.routines),
        review: toChoice(fields.review),
        browsing: toChoice(fields.browsing),
        documents: toChoice(fields.documents),
    };
}

function isModelInputError(value: ModelChoices | ModelInputError): value is ModelInputError {
    return 'error' in value;
}

// Routine and webhook turns use the routines choice and fall back to the chat choice. Undefined keeps the CLI default.
function chooseTurnModel(choices: ModelChoices, source: 'chat' | 'routine' | 'webhook'): string | undefined {
    const routinesChoice = source === 'chat' ? null : choices.routines;

    return routinesChoice ?? choices.chat ?? undefined;
}

export { MODEL_ALIASES, MODEL_ID_PATTERN, chooseTurnModel, isModelInputError, parseModelInput };
export type { ModelChoices, ModelInputError, ModelKind };
