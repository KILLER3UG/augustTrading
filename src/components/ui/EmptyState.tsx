import React from 'react';

type IconVariant = 'subtle' | 'bold';
type EmptyAlign = 'center' | 'start';

interface EmptyStateProps {
  /** Icon element (SVG or component) */
  icon?: React.ReactNode;
  /** Main heading */
  title: string;
  /** Supporting description */
  description?: string;
  /** Optional primary action button/link */
  action?: React.ReactNode;
  /** Optional secondary action (link, ghost button) */
  secondaryAction?: React.ReactNode;
  /** `subtle` (smaller chrome, fits in narrow docks) or `bold` (full-page panels) */
  iconVariant?: IconVariant;
  /** `center` (default) or `start` for left-aligned compact layouts */
  align?: EmptyAlign;
  /** Compact padding (use inside narrow panels like the Chart AI dock) */
  compact?: boolean;
  className?: string;
}

/**
 * Standardized empty state for lists, panels, and dashboards.
 *
 * Usage:
 *   <EmptyState
 *     icon={<BookmarkIcon className="w-8 h-8" aria-hidden="true" />}
 *     title="No saved analyses"
 *     description="Analyses you bookmark will appear here."
 *     action={<button>Run an Analysis</button>}
 *     secondaryAction={<button>Learn more</button>}
 *     iconVariant="subtle"
 *     align="start"
 *     compact
 *   />
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  secondaryAction,
  iconVariant = 'bold',
  align = 'center',
  compact = false,
  className = '',
}) => {
  const isCenter = align === 'center';
  const isSubtle = iconVariant === 'subtle';

  return (
    <div
      className={[
        'flex flex-col',
        isCenter ? 'items-center text-center' : 'items-start text-left',
        compact ? 'py-6 px-4' : 'py-16 px-6',
        className,
      ].filter(Boolean).join(' ')}
    >
      {icon && (
        <div
          className={[
            'flex items-center justify-center rounded-full bg-zinc-900 border border-hairline text-zinc-500',
            compact ? (isSubtle ? 'mb-3 h-10 w-10' : 'mb-4 h-12 w-12') : (isSubtle ? 'mb-4 h-12 w-12' : 'mb-5 h-16 w-16'),
          ].join(' ')}
          aria-hidden="true"
        >
          {icon}
        </div>
      )}
      <h3
        className={[
          'font-semibold text-zinc-300',
          compact ? 'text-ui-caption mb-1' : 'text-ui-base mb-1.5',
        ].join(' ')}
      >
        {title}
      </h3>
      {description && (
        <p
          className={[
            'text-zinc-600 leading-relaxed',
            compact ? 'text-ui-dense max-w-[28ch]' : 'text-ui-sm max-w-xs',
          ].join(' ')}
        >
          {description}
        </p>
      )}
      {(action || secondaryAction) && (
        <div
          className={[
            'flex gap-2',
            isCenter ? 'flex-col items-center mt-5' : 'flex-row items-center mt-4',
            compact ? 'mt-4' : '',
          ].filter(Boolean).join(' ')}
        >
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
};
