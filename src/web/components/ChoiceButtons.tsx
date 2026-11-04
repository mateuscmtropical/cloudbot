import type { ReactElement } from 'react';

import type { ChoiceOption } from '../../shared/chatTypes.ts';
import { Button } from './Button.tsx';

interface ChoiceButtonsProps {
    options: ChoiceOption[];
    chosenId: string | undefined;
    onChoose: (choiceId: string) => void;
}

function ChoiceButtons({ options, chosenId, onChoose }: ChoiceButtonsProps): ReactElement {
    const isChosen = chosenId !== undefined;

    return (
        <div className="choice-buttons">
            {options.map((option) => {
                const tone = option.id === chosenId ? 'selected' : 'default';

                return (
                    <Button
                        key={option.id}
                        tone={tone}
                        disabled={isChosen}
                        onClick={() => {
                            onChoose(option.id);
                        }}
                    >
                        {option.label}
                    </Button>
                );
            })}
        </div>
    );
}

export { ChoiceButtons };
export type { ChoiceButtonsProps };
