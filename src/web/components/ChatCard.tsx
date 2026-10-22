import type { ReactElement, ReactNode } from 'react';

interface ChatCardProps {
    // The text on top of the card. The controls go under it as children.
    text?: string | undefined;
    // An extra class for cards with their own inner layout, like the task board.
    className?: string | undefined;
    children?: ReactNode;
}

// The frame of every card in the chat, so all cards share one spacing. See Layout in docs/CODING_STANDARDS.md.
function ChatCard({ text, className, children }: ChatCardProps): ReactElement {
    const cardClassName = className === undefined ? 'setup-card' : `setup-card ${className}`;

    return (
        <div className={cardClassName}>
            {text === undefined ? null : <p className="card-text">{text}</p>}
            {children}
        </div>
    );
}

export { ChatCard };
export type { ChatCardProps };
