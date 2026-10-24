import type { ReactElement } from 'react';

import { EditIcon, MoreIcon, TrashIcon } from './icons.tsx';
import { PopoverMenu, PopoverMenuItem } from './PopoverMenu.tsx';

interface BotActionsMenuProps {
    botName: string;
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    onRename: () => void;
    onDelete: () => void;
}

function BotActionsMenu({ botName, isOpen, onOpenChange, onRename, onDelete }: BotActionsMenuProps): ReactElement {
    return (
        <PopoverMenu
            label={`Actions for ${botName}`}
            triggerLabel={`More options for ${botName}`}
            triggerIcon={<MoreIcon />}
            isOpen={isOpen}
            onOpenChange={onOpenChange}
        >
            {close => (
                <>
                    <PopoverMenuItem label="Rename" icon={<EditIcon />} close={close} onSelect={onRename} />
                    <PopoverMenuItem label="Delete" icon={<TrashIcon />} tone="danger" close={close} onSelect={onDelete} />
                </>
            )}
        </PopoverMenu>
    );
}

export { BotActionsMenu };
export type { BotActionsMenuProps };
