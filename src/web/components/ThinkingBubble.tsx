import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { MascotColorName, MascotShape } from '../../shared/mascot.ts';
import { MESSAGE_MASCOT_SIZE } from '../messageMascot.ts';
import { LINE_INTERVAL_MS, thinkingLineAt, toolPhrase } from '../thinkingBubble.ts';
import { CloudMascot } from './CloudMascot.tsx';

interface ThinkingBubbleProps {
    color: MascotColorName;
    shape: MascotShape;
    // The tool the bot is using now. When it is unset, the bubble cycles through the thinking lines.
    activeToolName?: string | undefined;
}

// The thinking lines change on a timer, not in CSS, so they still change when reduced motion is on.
function ThinkingBubble({ color, shape, activeToolName }: ThinkingBubbleProps): ReactElement {
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
        <div className="message message-assistant is-thinking has-mascot" role="status" aria-label="Bot is working">
            <CloudMascot color={color} shape={shape} state="thinking" size={MESSAGE_MASCOT_SIZE} />
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
