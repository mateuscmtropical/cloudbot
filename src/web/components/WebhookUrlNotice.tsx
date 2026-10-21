import type { ReactElement } from 'react';

interface WebhookUrlNoticeProps {
    name: string;
    url: string;
    onHide: () => void;
}

// Shows a new webhook URL once. The page keeps it only in memory, and Hide removes it.
function WebhookUrlNotice({ name, url, onHide }: WebhookUrlNoticeProps): ReactElement {
    return (
        <div className="webhook-created" role="status">
            <p>
                {`The URL of "${name}" is shown only now. Keep it secret: anyone with this URL can send the bot messages.`}
            </p>
            <input
                type="text"
                readOnly
                aria-label="Webhook URL"
                value={url}
                onFocus={(event) => {
                    event.currentTarget.select();
                }}
            />
            <button type="button" onClick={onHide}>Hide URL</button>
        </div>
    );
}

export { WebhookUrlNotice };
export type { WebhookUrlNoticeProps };
