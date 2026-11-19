import React from 'react';

interface SpinnerProps {
  /** Size in Tailwind units, e.g. 'w-4 h-4' */
  size?: string;
  /** Color class, e.g. 'border-zinc-400' */
  color?: string;
  /** Additional classes */
  className?: string;
}

/**
 * Standardized inline spinner — a bordered circle with transparent top.
 * Replaces ad-hoc `border-2 border-X border-t-transparent rounded-full animate-spin` divs.
 *
 * Usage:
 *   <Spinner size="w-4 h-4" color="border-zinc-400" />
 *   <Spinner size="w-8 h-8" color="border-emerald-400" className="ml-2" />
 */
export const Spinner: React.FC<SpinnerProps> = ({
  size = 'w-4 h-4',
  color = 'border-zinc-400',
  className = '',
}) => {
  return (
    <div
      className={`${size} border-2 ${color} border-t-transparent rounded-full animate-spin ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
};

export default Spinner;
