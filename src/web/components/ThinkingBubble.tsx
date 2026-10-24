import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { MascotColorName, MascotShape } from '../../shared/mascot.ts';
import { LINE_INTERVAL_MS, thinkingLineAt, toolPhrase } from '../thinkingBubble.ts';
import { CloudMascot } from './CloudMascot.tsx';

interface ThinkingBubbleProps {
    // The tool the bot is using now. When it is unset, the line cycles through the thinking lines.
    activeToolName?: string | undefined;
    // The bot's own mascot, drawn small at the start of the line.
    mascotColor: MascotColorName;
    mascotShape: MascotShape;
}

const STATUS_MASCOT_SIZE = 24;

// A status line under the last message, with the mascot looking around and a shine that sweeps the text.
// The lines change on a timer, not in CSS, so they still change when reduced motion is on.
function ThinkingBubble({ activeToolName, mascotColor, mascotShape }: ThinkingBubbleProps): ReactElement {
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
            <div className="thinking-status">
                <CloudMascot color={mascotColor} shape={mascotShape} state="working" size={STATUS_MASCOT_SIZE} />
                {/* The line changes every few seconds, so it stays silent. The label above is what a screen reader gets.
                    The key starts the shine again on each new line. */}
                <span key={line} className="thinking-line" aria-live="off">{line}</span>
            </div>
        </div>
    );
}

export { ThinkingBubble };
export type { ThinkingBubbleProps };
