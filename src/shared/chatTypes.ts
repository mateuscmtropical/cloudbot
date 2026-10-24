import type { MascotColorName, MascotShape } from './mascot.ts';
import type { TaskCard } from './taskTypes.ts';

type ChatRole = 'user' | 'assistant' | 'system';

type ToolStatus = 'running' | 'done' | 'error';

interface ChoiceOption {
    id: string;
    label: string;
    // Set on a choice that starts a sign-in at once. The web page opens a tab in the tap and puts the link in it.
    opensLink?: boolean;
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
    // Set on the message that says a provider is ready, since the bot of the chat now runs on it.
    providerSwitched?: boolean;
}

interface ChoiceBody {
    kind: 'choice';
    prompt: string;
    options: ChoiceOption[];
    chosenId?: string;
    // Set on a question that holds a tool call until the owner answers.
    isApproval?: boolean;
    // Set on the card that turns on push notifications. Its first button asks the browser for permission.
    isNotificationOptIn?: boolean;
    // Set on the card that turns them off. Its first button removes the subscription of this browser.
    isNotificationOptOut?: boolean;
    // Set on the card that adds a passkey. Its first button asks the browser to make one.
    isPasskeyAdd?: boolean;
    // Set on the card that offers another provider after a usage limit. Each option id is a provider id, or "wait".
    isProviderSwitch?: boolean;
    // Set on the card that removes this passkey. Its first button removes it.
    removesPasskeyId?: string;
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

// The bot handed over its screen. The button opens the Screen panel again, if the owner closed it.
interface ScreenLinkBody {
    kind: 'screenLink';
    text: string;
}

// The task board as it was when the bot posted it. It does not change after that.
interface TasksBody {
    kind: 'tasks';
    tasks: TaskCard[];
    // Tasks that did not fit on the card.
    hiddenCount: number;
}

type MessageBody = TextBody | ChoiceBody | LinkBody | CodeFieldBody | SecureFormBody | FileBody | ToolActivityBody | ScreenLinkBody | TasksBody;

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
    mascotColor: MascotColorName;
    mascotShape: MascotShape;
    lastMessagePreview: string;
    lastActivityAt?: number;
    hasUnread: boolean;
    // The sequence of the latest message the owner can read, not counting the owner's own and tool lines. Zero when there is none.
    lastMessageSequence: number;
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

// A tool call of the bot has started. It is not stored, and the web app shows it in the thinking bubble.
interface ChatToolStartedEvent {
    type: 'toolStarted';
    botId: string;
    // The tool name as the CLI spells it, such as WebFetch or mcp__cloudbot__browser_open.
    toolName: string;
}

// A new webhook URL, sent once to the open web app. It is never stored, so the web app keeps it only in memory.
interface ChatWebhookUrlEvent {
    type: 'webhookUrl';
    botId: string;
    name: string;
    url: string;
}

// One time sign-in details for a person. The event is sent live and is never stored as a chat message.
interface ChatPersonCredentialsEvent {
    type: 'personCredentials';
    botId: string;
    name: string;
    address: string;
    password: string;
}

// The bot asked for the screen, or opened a page in its browser for the first time in a turn. The open web app shows
// the Screen panel for this bot, so the owner sees it at once.
interface ChatScreenEvent {
    type: 'screen';
    botId: string;
}

// The bot was deleted. The web app drops it from the list. Sent before the bot's listeners are dropped.
interface ChatBotDeletedEvent {
    type: 'botDeleted';
    botId: string;
}

// A check-in found nothing for the owner, so its messages were deleted. The web app drops them from the list.
interface ChatMessagesRemovedEvent {
    type: 'messagesRemoved';
    botId: string;
    messageIds: string[];
}

type ChatEvent = ChatMessageEvent | ChatTurnEvent | ChatTextDeltaEvent | ChatToolStartedEvent | ChatWebhookUrlEvent | ChatPersonCredentialsEvent | ChatScreenEvent | ChatBotDeletedEvent | ChatMessagesRemovedEvent;

// A rule the owner set for a bot. Block rules may name tools the bot cannot use.
interface BotRule {
    id: string;
    kind: 'allow' | 'block';
    text: string;
    blockedTools: string[];
}

// Who may act on the bot's desktop.
type ScreenHolderName = 'bot' | 'person';

// The live view of the screen: VNC on the Docker desktop, or the browser's frames in local mode.
type ScreenViewName = 'vnc' | 'screencast';

export type {
    ScreenHolderName,
    ScreenViewName,
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
    TasksBody,
    TextBody,
    ToolActivityBody,
    ToolStatus,
    ChatTextDeltaEvent,
    ChatTurnEvent,
    ChatWebhookUrlEvent,
    ChatPersonCredentialsEvent,
    ChatScreenEvent,
    ChatBotDeletedEvent,
    ChatMessagesRemovedEvent,
    ScreenLinkBody,
};
