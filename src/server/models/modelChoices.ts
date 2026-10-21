// The aliases the SDK takes in its model option. The list follows the comment on AgentDefinition.model
// in node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts.
const MODEL_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku'];
// Full model ids start with "claude-". The pattern keeps any other text away from the CLI.
const MODEL_ID_PATTERN = /^claude-[a-z0-9.-]+$/;
const MAX_MODEL_LENGTH = 100;
// The first three kinds pick the model of a turn. browsing and documents are helper agents, and a null
// choice for either one means the bot has no helper for that work.
const MODEL_KINDS = ['chat', 'routines', 'review', 'browsing', 'documents'] as const;
// The levels of the SDK effort option, as EffortLevel in node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
// The kind and the field name the web app and the tool use for its effort. The order is the panel's order.
const EFFORT_FIELDS = [
    ['chat', 'chatEffort'],
    ['routines', 'routinesEffort'],
    ['review', 'reviewEffort'],
    ['browsing', 'browsingEffort'],
    ['documents', 'documentsEffort'],
] as const;

type ModelKind = (typeof MODEL_KINDS)[number];
type EffortLevel = (typeof EFFORT_LEVELS)[number];

// A null choice means the CLI default model, or no helper for browsing and documents.
interface ModelChoices {
    chat: string | null;
    routines: string | null;
    review: string | null;
    browsing: string | null;
    documents: string | null;
}

// A null effort means the CLI default effort. The effort of a helper is null when it has no helper.
interface EffortChoices {
    chat: EffortLevel | null;
    routines: EffortLevel | null;
    review: EffortLevel | null;
    browsing: EffortLevel | null;
    documents: EffortLevel | null;
}

// The effort fields as the web app and the bot's tool name them.
interface EffortFields {
    chatEffort: EffortLevel | null;
    routinesEffort: EffortLevel | null;
    reviewEffort: EffortLevel | null;
    browsingEffort: EffortLevel | null;
    documentsEffort: EffortLevel | null;
}

interface ModelInputError {
    error: string;
}

const INVALID_BODY: ModelInputError = { error: 'Send an object with the chat, routines, review, browsing and documents models.' };
const INVALID_EFFORT_BODY: ModelInputError = { error: 'Send an object with the chat, routines, review, browsing and documents efforts.' };

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

function isEffortLevel(value: unknown): value is EffortLevel {
    return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

function isValidEffort(value: unknown): boolean {
    return value === undefined || value === null || isEffortLevel(value);
}

// Only a level from the list is kept. A value that is not one becomes the default.
function toEffortChoice(value: unknown): EffortLevel | null {
    return isEffortLevel(value) ? value : null;
}

// A missing or null effort field means the CLI default. The field names are the ones the web app and the tool use.
function parseEffortInput(payload: unknown): EffortChoices | ModelInputError {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return INVALID_EFFORT_BODY;
    }

    const fields = payload as Record<string, unknown>;
    const invalidKinds = EFFORT_FIELDS.filter(([, field]) => !isValidEffort(fields[field]));
    const firstInvalid = invalidKinds[0];

    if (firstInvalid !== undefined) {
        return { error: `The ${firstInvalid[0]} effort must be null, or one of low, medium, high, xhigh or max.` };
    }

    return {
        chat: toEffortChoice(fields.chatEffort),
        routines: toEffortChoice(fields.routinesEffort),
        review: toEffortChoice(fields.reviewEffort),
        browsing: toEffortChoice(fields.browsingEffort),
        documents: toEffortChoice(fields.documentsEffort),
    };
}

function toEffortFields(efforts: EffortChoices): EffortFields {
    return {
        chatEffort: efforts.chat,
        routinesEffort: efforts.routines,
        reviewEffort: efforts.review,
        browsingEffort: efforts.browsing,
        documentsEffort: efforts.documents,
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

// The same rule as the model: routine and webhook turns use the routines effort and fall back to the chat effort.
function chooseTurnEffort(efforts: EffortChoices, source: 'chat' | 'routine' | 'webhook'): EffortLevel | undefined {
    const routinesEffort = source === 'chat' ? null : efforts.routines;

    return routinesEffort ?? efforts.chat ?? undefined;
}

export { EFFORT_LEVELS, MODEL_ALIASES, MODEL_ID_PATTERN, chooseTurnEffort, chooseTurnModel, isModelInputError, parseEffortInput, parseModelInput, toEffortChoice, toEffortFields };
export type { EffortChoices, EffortFields, EffortLevel, ModelChoices, ModelInputError, ModelKind };
