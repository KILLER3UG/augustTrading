import React, { lazy, memo, Suspense } from 'react';

interface MarkdownContentProps {
  /** Markdown text to render. */
  content: string;
  /** True while the message is actively streaming (enables block-split memoization + chunk fade). */
  streaming?: boolean;
  /** Extra classes for the prose wrapper (e.g. text color overrides). */
  className?: string;
}

/**
 * Shared markdown renderer for AI text. Thin lazy boundary: the heavy
 * react-markdown chunk is only fetched when the first AI message renders
 * (then cached), keeping ~300KB out of the startup bundle. While the chunk
 * loads, the raw text is shown pre-wrapped in the same layout so there is
 * no visual shift.
 *
 * Memoized: streamed AI messages re-render constantly (each chunk, each
 * chatContext change). With identical props, memo skips both the Suspense
 * wrapper and the markdown re-parse entirely.
 */
const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'));

const MarkdownFallback: React.FC<MarkdownContentProps> = ({ content, className }) => (
  <div className={`text-ui-base leading-relaxed text-zinc-300 whitespace-pre-wrap ${className ?? ''}`}>
    {content || ''}
  </div>
);

const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, streaming, className }) => (
  <Suspense fallback={<MarkdownFallback content={content} className={className} />}>
    <MarkdownRenderer content={content} streaming={streaming} className={className} />
  </Suspense>
);

export default memo(MarkdownContent);
