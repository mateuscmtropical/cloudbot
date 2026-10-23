import type { ChatMessage } from '../shared/chatTypes.ts';

const PROVIDER_USE_TOOL_SUFFIX = '__provider_use';

// How many times the chat shows that the bot's provider changed: a provider card the owner answered, and the bot's own provider_use calls.
// The header reads the provider again when this number goes up.
function countProviderChanges(messages: ChatMessage[]): number {
    const changes = messages.filter((message) => {
        if (message.body.kind === 'choice') {
            return message.body.isProviderSwitch === true && message.body.chosenId !== undefined;
        }

        return message.body.kind === 'toolActivity' && message.body.toolName.endsWith(PROVIDER_USE_TOOL_SUFFIX) && message.body.status === 'done';
    });

    return changes.length;
}

export { countProviderChanges };
