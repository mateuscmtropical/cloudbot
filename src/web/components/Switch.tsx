import type { ChangeEventHandler, ReactElement } from 'react';

interface SwitchProps {
    label: string;
    checked: boolean;
    disabled?: boolean;
    onChange: ChangeEventHandler<HTMLInputElement>;
}

function Switch({ label, checked, disabled = false, onChange }: SwitchProps): ReactElement {
    return (
        <label className="switch-control">
            <span className="switch-label">{label}</span>
            <input className="switch-input" type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />
            <span className="switch-track" aria-hidden="true" />
        </label>
    );
}

export { Switch };
export type { SwitchProps };
