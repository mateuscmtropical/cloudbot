import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { LINE_INTERVAL_MS, thinkingLineAt, toolPhrase } from '../thinkingBubble.ts';

interface ThinkingBubbleProps {
    // The tool the bot is using now. When it is unset, the bubble cycles through the thinking lines.
    activeToolName?: string | undefined;
}

// The thinking lines change on a timer, not in CSS, so they still change when reduced motion is on.
function ThinkingBubble({ activeToolName }: ThinkingBubbleProps): ReactElement {
    const [lineIndex, setLineIndex] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => {
            setLineIndex(index => index + 1);
        }, LINE_INTERVAL_MS);

        return () => {
            clearInterval(timer);
        };
    }, []);

    const line = activeToolName === undefined ? thinkingLineAt(lineIndex) : toolPhrase(activeToolName);

    return (
        <div className="message message-assistant is-thinking" role="status" aria-label="Bot is working">
            <div className="bubble thinking-bubble">
                {/* The line changes every few seconds, so it stays silent. The label above is what a screen reader gets. */}
                <span className="thinking-line" aria-live="off">{line}</span>
                <span className="thinking-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                </span>
            </div>
        </div>
    );
}

export { ThinkingBubble };
export type { ThinkingBubbleProps };
