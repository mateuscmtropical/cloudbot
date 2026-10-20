import type { ReactElement } from 'react';

import type { ChoiceOption } from '../../shared/chatTypes.ts';

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
                const isSelected = option.id === chosenId;
                const className = isSelected ? 'choice-button is-selected' : 'choice-button';

                return (
                    <button
                        key={option.id}
                        type="button"
                        className={className}
                        disabled={isChosen}
                        onClick={() => {
                            onChoose(option.id);
                        }}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}

export { ChoiceButtons };
export type { ChoiceButtonsProps };
