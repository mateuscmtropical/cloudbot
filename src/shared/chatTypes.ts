type ChatRole = 'user' | 'assistant' | 'system';

type ToolStatus = 'running' | 'done' | 'error';

interface ChoiceOption {
    id: string;
    label: string;
}

interface TextBody {
    kind: 'text';
    text: string;
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
}

interface ToolActivityBody {
    kind: 'toolActivity';
    toolName: string;
    status: ToolStatus;
    summary: string;
}

type MessageBody = TextBody | ChoiceBody | LinkBody | CodeFieldBody | SecureFormBody | ToolActivityBody;

interface ChatMessage {
    id: string;
    botId: string;
    role: ChatRole;
    createdAt: number;
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

type ChatEvent = ChatMessageEvent | ChatTurnEvent;

export type {
    BotSummary,
    ChatEvent,
    ChatMessage,
    ChatRole,
    ChoiceBody,
    ChoiceOption,
    CodeFieldBody,
    LinkBody,
    MessageBody,
    ChatMessageEvent,
    SecureFormBody,
    TextBody,
    ToolActivityBody,
    ToolStatus,
    ChatTurnEvent,
};
