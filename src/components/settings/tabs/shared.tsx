// ─── Shared UI Helpers ────────────────────────────────────────────────────────
// One settings page language. A page is a title + description over SECTION
// LABELS; each label sits above one rounded card whose rows are separated by
// thin DASHED dividers. Every tab composes these helpers instead of
// hand-rolling a card — a tab that hand-rolls its own header is how one page
// kept a 28px title with a kicker while its neighbour had none.
//
// `data-settings-row` is the search contract: SettingsMenu's search box jumps
// to a page, then finds the row by its title and scrolls it into view.
import React from 'react';

const SettingsGroup: React.FC<{
    title?: string;
    description?: string;
    children: React.ReactNode;
}> = ({ title, description, children }) => (
    <section className="pt-6 first:pt-0">
        {(title || description) && (
            <div className="mb-2">
                {title && (
                    <h4 className="font-mono text-ui-xs font-medium uppercase tracking-[0.08em] text-zinc-500">{title}</h4>
                )}
                {description && <p className="mt-1 text-ui-sm leading-relaxed text-zinc-500">{description}</p>}
            </div>
        )}
        <div className="motion-list divide-y divide-dashed divide-white/[0.07] overflow-hidden rounded-card border border-white/[0.06] bg-zinc-900/40 px-4">
            {children}
        </div>
    </section>
);

const SettingsRow: React.FC<{
    icon?: React.ReactNode;
    title: string;
    description?: React.ReactNode;
    control?: React.ReactNode;
    /** For a control that needs the row's full width (an editor, not a
     *  switch) — it drops below the label instead of squeezing the text. */
    stacked?: boolean;
}> = ({ icon, title, description, control, stacked = false }) => (
    <div
        data-settings-row={title}
        className={`flex gap-4 py-3.5 transition-colors hover:bg-white/[0.02] ${
            stacked ? 'flex-col items-start' : 'items-center justify-between'
        }`}
    >
        <div className="flex min-w-0 flex-1 items-start gap-3">
            {icon && <span aria-hidden="true" className="mt-0.5 shrink-0 text-zinc-500">{icon}</span>}
            <div className="min-w-0">
                <div className="text-ui-sm font-medium text-zinc-100">{title}</div>
                {description && (
                    <div className="mt-1 text-ui-sm leading-relaxed text-zinc-500">{description}</div>
                )}
            </div>
        </div>
        {control && <div className={stacked ? 'w-full' : 'shrink-0'}>{control}</div>}
    </div>
);

const SettingsPageHeader: React.FC<{ title: string; description?: string; action?: React.ReactNode }> = ({ title, description, action }) => (
    <header className="mb-7 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
            <h3 className="text-ui-display font-semibold tracking-[-0.03em] text-zinc-100">{title}</h3>
            {description && <p className="mt-2 max-w-2xl text-ui-sm leading-relaxed text-zinc-500">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
    </header>
);

/** One button shape for every settings row. `danger` is the ONLY red control —
 *  used for destructive actions, never for emphasis. */
const SettingsButton: React.FC<{
    onClick: () => void;
    children: React.ReactNode;
    tone?: 'default' | 'danger';
    disabled?: boolean;
    ariaLabel?: string;
    testId?: string;
}> = ({ onClick, children, tone = 'default', disabled = false, ariaLabel, testId }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
        className={`motion-press inline-flex items-center gap-1.5 rounded-control border px-3 py-1.5 text-ui-dense font-semibold transition-colors disabled:opacity-40 ${
            tone === 'danger'
                ? 'border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200'
                : 'border-white/10 bg-zinc-800 text-zinc-300 hover:border-white/20 hover:bg-zinc-700 hover:text-zinc-100'
        }`}
    >
        {children}
    </button>
);

/** Two-choice setting that belongs INSIDE a row rather than as two full-width
 *  cards — the reference keeps the control on the row's right edge. */
const SegmentedControl: React.FC<{
    value: string;
    options: Array<{ id: string; label: string; title?: string }>;
    onChange: (id: string) => void;
    ariaLabel: string;
}> = ({ value, options, onChange, ariaLabel }) => (
    <div role="radiogroup" aria-label={ariaLabel}
        className="flex items-center gap-0.5 rounded-full border border-white/[0.07] bg-zinc-800/70 p-0.5">
        {options.map(o => (
            <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={value === o.id}
                title={o.title}
                onClick={() => onChange(o.id)}
                className={`motion-press rounded-full px-2.5 py-1 text-ui-dense font-semibold transition-colors ${
                    value === o.id ? 'bg-zinc-700 text-zinc-100 ring-1 ring-white/[0.07]' : 'text-zinc-500 hover:text-zinc-300'
                }`}
            >
                {o.label}
            </button>
        ))}
    </div>
);

export { SettingsGroup, SettingsRow, SettingsPageHeader, SettingsButton, SegmentedControl };
