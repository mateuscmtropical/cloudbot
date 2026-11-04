import type { ButtonHTMLAttributes, ReactElement, Ref } from 'react';

type ButtonTone = 'default' | 'selected' | 'danger' | 'quiet';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    tone?: ButtonTone;
    ref?: Ref<HTMLButtonElement>;
}

const TONE_CLASSES: Record<ButtonTone, string> = {
    default: 'choice-button',
    selected: 'choice-button is-selected',
    danger: 'choice-button is-danger',
    quiet: 'choice-button is-quiet',
};

// The text button of the app. It is type="button" unless a form asks for submit.
function Button({ tone = 'default', type = 'button', className, ...buttonProps }: ButtonProps): ReactElement {
    const buttonClass = className === undefined ? TONE_CLASSES[tone] : `${TONE_CLASSES[tone]} ${className}`;

    return <button {...buttonProps} type={type === 'submit' ? 'submit' : 'button'} className={buttonClass} />;
}

export { Button };
export type { ButtonProps, ButtonTone };
