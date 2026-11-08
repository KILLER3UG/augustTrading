import React from 'react';

interface ToggleSwitchProps {
    checked: boolean;
    onChange: () => void;
    label?: string;
    disabled?: boolean;
}

/**
 * ToggleSwitch — the app's single toggle primitive. Settings previously had
 * five visually different toggle implementations (button-pill, checkbox,
 * CSS-only, inline-styled); this is the one they all delegate to.
 */
export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({ checked, onChange, label = 'Toggle setting', disabled = false }) => (
    <button
        type="button"
        onClick={onChange}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors duration-[150ms] ease-[var(--ease-snappy)] ${
            disabled ? 'opacity-50 cursor-not-allowed' : ''
        } ${checked ? 'bg-accent' : 'bg-zinc-700'}`}
    >
        <div
            className={`bg-white w-4 h-4 rounded-full transform transition-transform duration-[150ms] ease-[var(--ease-snappy)] ${
                checked ? 'translate-x-5' : 'translate-x-0'
            }`}
        />
    </button>
);

export default ToggleSwitch;
