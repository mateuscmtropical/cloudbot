import type { ReactElement } from 'react';

import type { MascotColorName, MascotEyes, MascotShape } from '../../shared/mascot.ts';
import { CloudMascot } from './CloudMascot.tsx';

const MAX_SHOWN = 3;

interface StackedMascot {
    botId: string;
    mascotColor: MascotColorName;
    mascotShape: MascotShape;
    mascotEyes: MascotEyes;
}

interface MascotStackProps {
    members: StackedMascot[];
    size: number;
}

// The first few mascots of a group, overlapping, and a count of the rest.
function MascotStack({ members, size }: MascotStackProps): ReactElement {
    const shown = members.slice(0, MAX_SHOWN);
    const hiddenCount = members.length - shown.length;

    return (
        <span className="mascot-stack" aria-hidden="true">
            {shown.map(member => <CloudMascot key={member.botId} color={member.mascotColor} shape={member.mascotShape} eyes={member.mascotEyes} state="idle" size={size} />)}
            {hiddenCount > 0 ? <span className="mascot-stack-more">{`+${String(hiddenCount)}`}</span> : null}
        </span>
    );
}

export { MascotStack };
export type { MascotStackProps };
