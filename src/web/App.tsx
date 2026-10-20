import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary, ChatEvent, ChatMessage } from '../shared/chatTypes.ts';
import { BotList } from './components/BotList.tsx';
import { ConversationView } from './components/ConversationView.tsx';
import { listBots, listMessages, sendMessage, stopTurn, submitChoice, submitCode, submitSecret, subscribeToEvents, uploadAttachments } from './apiClient.ts';
import { upsertMessage } from './messageList.ts';

function App(): ReactElement {
    const [bots, setBots] = useState<BotSummary[]>([]);
    const [selectedBotId, setSelectedBotId] = useState<string | undefined>(undefined);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [runningBotId, setRunningBotId] = useState<string | undefined>(undefined);
    const [isBotListOpen, setIsBotListOpen] = useState(false);
    const [errorText, setErrorText] = useState<string | undefined>(undefined);

    useEffect(() => {
        listBots()
            .then((loadedBots) => {
                const firstBotId = loadedBots[0]?.id;

                setBots(loadedBots);
                setSelectedBotId(firstBotId);
            })
            .catch(() => {
                setErrorText('Could not load your bots.');
            });
    }, []);

    useEffect(() => {
        if (selectedBotId === undefined) {
            return;
        }

        let isCurrent = true;

        listMessages(selectedBotId)
            .then((loadedMessages) => {
                if (isCurrent) {
                    setMessages(loadedMessages);
                }
            })
            .catch(() => {
                setErrorText('Could not load the conversation.');
            });

        const unsubscribe = subscribeToEvents(selectedBotId, (event: ChatEvent) => {
            if (event.type === 'message') {
                setMessages(previousMessages => upsertMessage(previousMessages, event.message));

                return;
            }

            setRunningBotId(event.isRunning ? event.botId : undefined);
        });

        return () => {
            isCurrent = false;
            unsubscribe();
        };
    }, [selectedBotId]);

    function showMessageResult(resultPromise: Promise<ChatMessage>): void {
        resultPromise
            .then((savedMessage) => {
                setMessages(previousMessages => upsertMessage(previousMessages, savedMessage));
            })
            .catch(() => {
                setErrorText('The request failed. Try again.');
            });
    }

    function handleSelectBot(botId: string): void {
        setSelectedBotId(botId);
        setIsBotListOpen(false);
    }

    function handleSend(text: string): void {
        if (selectedBotId === undefined) {
            return;
        }

        setRunningBotId(selectedBotId);
        const sendPromise = sendMessage(selectedBotId, text);

        showMessageResult(sendPromise);
    }

    function handleStop(): void {
        if (selectedBotId === undefined) {
            return;
        }

        const stopPromise = stopTurn(selectedBotId);

        stopPromise.catch(() => {
            setErrorText('Could not stop the bot.');
        });
    }

    function handleAttach(files: File[]): void {
        if (selectedBotId === undefined) {
            return;
        }

        const uploadPromise = uploadAttachments(selectedBotId, files);

        uploadPromise.catch(() => {
            setErrorText('Could not upload the files.');
        });
    }

    function handleChoose(messageId: string, choiceId: string): void {
        if (selectedBotId === undefined) {
            return;
        }

        const choicePromise = submitChoice(selectedBotId, messageId, choiceId);

        showMessageResult(choicePromise);
    }

    function handleSubmitCode(messageId: string, code: string): void {
        if (selectedBotId === undefined) {
            return;
        }

        const codePromise = submitCode(selectedBotId, messageId, code);

        showMessageResult(codePromise);
    }

    function handleSubmitSecret(messageId: string, value: string): void {
        if (selectedBotId === undefined) {
            return;
        }

        const secretPromise = submitSecret(selectedBotId, messageId, value);

        showMessageResult(secretPromise);
    }

    const selectedBot = bots.find(bot => bot.id === selectedBotId);
    const visibleMessages = messages.filter(message => message.botId === selectedBotId);
    const isRunning = selectedBotId !== undefined && runningBotId === selectedBotId;

    return (
        <div className="app">
            <BotList
                bots={bots}
                selectedBotId={selectedBotId}
                isOpen={isBotListOpen}
                onSelectBot={handleSelectBot}
            />
            {isBotListOpen
                ? (
                        <button
                            type="button"
                            className="scrim"
                            aria-label="Close bot list"
                            onClick={() => {
                                setIsBotListOpen(false);
                            }}
                        />
                    )
                : null}
            <main className="main-column">
                {errorText === undefined
                    ? null
                    : (
                            <p className="error-banner" role="alert">{errorText}</p>
                        )}
                <ConversationView
                    bot={selectedBot}
                    messages={visibleMessages}
                    isRunning={isRunning}
                    actions={{ onChoose: handleChoose, onSubmitCode: handleSubmitCode, onSubmitSecret: handleSubmitSecret }}
                    onOpenBotList={() => {
                        setIsBotListOpen(true);
                    }}
                    onSend={handleSend}
                    onStop={handleStop}
                    onAttach={handleAttach}
                />
            </main>
        </div>
    );
}

export { App };
