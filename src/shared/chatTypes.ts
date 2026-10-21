type ChatRole = 'user' | 'assistant' | 'system';

type ToolStatus = 'running' | 'done' | 'error';

interface ChoiceOption {
    id: string;
    label: string;
}

interface PendingUpload {
    id: string;
    name: string;
    sizeBytes: number;
}

interface AttachmentSummary {
    name: string;
    mimeType: string;
    sizeBytes: number;
}

interface TextBody {
    kind: 'text';
    text: string;
    attachments?: AttachmentSummary[];
    // Set on a user message sent during a turn. Cleared when its turn starts.
    isQueued?: boolean;
}

interface ChoiceBody {
    kind: 'choice';
    prompt: string;
    options: ChoiceOption[];
    chosenId?: string;
}

interface LinkBody {
    kind: 'link';
    text: string;
    url: string;
    label: string;
}

interface CodeFieldBody {
    kind: 'codeField';
    prompt: string;
    placeholder: string;
    submitted: boolean;
}

interface SecureFormBody {
    kind: 'secureForm';
    prompt: string;
    secretName: string;
    submitted: boolean;
    // Set when the bot asked for the secret. The value may be used only on this origin.
    site?: string;
}

interface FileBody {
    kind: 'file';
    name: string;
    mimeType: string;
    sizeBytes: number;
    // The stored copy. The web app downloads it through the message id.
    fileId: string;
}

interface ToolActivityBody {
    kind: 'toolActivity';
    toolName: string;
    status: ToolStatus;
    summary: string;
}

type MessageBody = TextBody | ChoiceBody | LinkBody | CodeFieldBody | SecureFormBody | FileBody | ToolActivityBody;

interface ChatMessage {
    id: string;
    botId: string;
    role: ChatRole;
    createdAt: number;
    // The store insertion order. Messages created in the same millisecond sort by it.
    sequence: number;
    body: MessageBody;
}

interface BotSummary {
    id: string;
    name: string;
    title: string;
    avatarColor: string;
    lastMessagePreview: string;
    hasUnread: boolean;
}

interface ChatMessageEvent {
    type: 'message';
    message: ChatMessage;
}

interface ChatTurnEvent {
    type: 'turn';
    botId: string;
    isRunning: boolean;
}

// Partial text of the assistant block that is still being written. The whole
// block arrives later as a message event, which replaces this draft.
interface ChatTextDeltaEvent {
    type: 'textDelta';
    botId: string;
    text: string;
}

type ChatEvent = ChatMessageEvent | ChatTurnEvent | ChatTextDeltaEvent;

// A rule the owner set for a bot. Block rules may name tools the bot cannot use.
interface BotRule {
    id: string;
    kind: 'allow' | 'block';
    text: string;
    blockedTools: string[];
}

// Who may act on the bot's desktop.
type ScreenHolderName = 'bot' | 'person';

export type {
    ScreenHolderName,
    AttachmentSummary,
    BotRule,
    PendingUpload,
    BotSummary,
    ChatEvent,
    ChatMessage,
    ChatRole,
    ChoiceBody,
    ChoiceOption,
    CodeFieldBody,
    FileBody,
    LinkBody,
    MessageBody,
    ChatMessageEvent,
    SecureFormBody,
    TextBody,
    ToolActivityBody,
    ToolStatus,
    ChatTextDeltaEvent,
    ChatTurnEvent,
};
