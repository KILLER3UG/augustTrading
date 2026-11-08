import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

// ─── Math preparation ───────────────────────────────────────────────────────
// Two things must be true at once here, and remark-math only knows about one
// of them: `$` is its inline delimiter, and in THIS app `$` is money first.

/** Code spans and fences are verbatim — CommonMark lets a single-backtick span
 *  cross line breaks, so the pattern mirrors the parser rather than assuming a
 *  line. Everything between these captures is prose, and only prose gets math
 *  prep: a regex like `/\[0\]/` in a code span must not become math. */
const CODE_SEGMENT = /(`{3,}[\s\S]*?(?:`{3,}|$)|`+[^`]*?`+)/g;

/** A `$` that directly precedes a digit is a price in this app: "$100" opens
 *  nothing. Measured without this guard, "Risk $100 on the entry, target
 *  $200" parsed as ONE inline math span and rendered as
 *  "Risk 100ontheentry,target100 on the entry, target 200" — the money
 *  vanished and the words fused. Not `$500.25`-shaped only: ANY digit. A `$`
 *  behind a backslash (already escaped) or another `$` (a `$$` pair) is left
 *  alone so display math and existing escapes survive. The cost is a formula
 *  that STARTS with a digit (`$0.5$`) stays literal — never the trade of
 *  losing a price. */
const protectMoney = (text: string): string => text.replace(/(?<![$\\])\$(?=\d)/g, '\\$');

/** `\[...\]` / `\(...\)` are KaTeX's own delimiters, but markdown eats the
 *  backslash before anyone can typeset them ("\(" renders as "("). Rewriting
 *  them onto `$` only when the body LOOKS like math keeps `\[2\]` — a bracket
 *  escape for a citation or an index — as the "2" it renders as today. */
const LOOKS_LIKE_LATEX = /[\\^_{}=]/;

const rewriteParenDelimiters = (text: string): string => text
    .replace(/\\\(([\s\S]*?)\\\)/g, (all, inner: string) => (
        LOOKS_LIKE_LATEX.test(inner) ? `$${inner}$` : all
    ))
    .replace(/\\\[([\s\S]*?)\\\]/g, (all, inner: string) => (
        LOOKS_LIKE_LATEX.test(inner) ? `$$${inner}$$` : all
    ));

/** A display formula written on ONE line — `$$R:R = …$$`, which is how most
 *  models emit it — parses as INLINE math here, so it typesets as a run-in
 *  span instead of the centered block the author meant. Giving the body its
 *  own lines sends micromark down the flow path. Only whole lines qualify
 *  (`$$` … `$$` with nothing after), so a trailing sentence can never be
 *  swallowed by an unclosed display block. */
const expandSingleLineDisplay = (text: string): string => text.replace(
    /^([ \t]*)\$\$([^\n]+?)\$\$[ \t]*$/gm,
    (all, indent: string, body: string) => (body.trim() ? `${indent}$$\n${body}\n${indent}$$` : all),
);

const prepareMath = (source: string): string => {
    let out = '';
    let cursor = 0;
    let match: RegExpExecArray | null;
    CODE_SEGMENT.lastIndex = 0;
    while ((match = CODE_SEGMENT.exec(source)) !== null) {
        out += rewriteParenDelimiters(protectMoney(source.slice(cursor, match.index)));
        out += match[0];
        cursor = match.index + match[0].length;
    }
    out += rewriteParenDelimiters(protectMoney(source.slice(cursor)));
    return expandSingleLineDisplay(out);
};

/** A formula the model botched renders as its own source in the error color —
 *  KaTeX's default is to THROW, and a throw inside `messages.map()` takes the
 *  whole bubble (or every later row) down with it. AI text is untrusted input
 *  for KaTeX too. */
const KATEX_OPTIONS = { throwOnError: false, errorColor: '#f6465d' };

interface MarkdownRendererProps {
  /** Markdown text to render. */
  content: string;
  /** Extra classes for the prose wrapper (e.g. text color overrides). */
  className?: string;
}

/**
 * Heavy markdown renderer (react-markdown + remark-gfm + KaTeX). Kept in its
 * own module so MarkdownContent can lazy-load it — this whole chunk (the
 * largest single dependency in the app, now including katex) is only fetched
 * on the first render of an AI message instead of being bundled into the
 * startup entry. ReactMarkdown escapes raw HTML by default, so AI output
 * can't inject markup; that escaping is pinned in tests/markdownRenderer.
 *
 * Math: `$…$`, `$$…$$` and the paren delimiters models emit are typeset.
 * `$` is also this app's currency symbol, so prepareMath arbitrates before
 * the parser sees the text — prices are never a formula.
 *
 * Typography: tighter paragraphs (my-3,
 * 1.65 line-height instead of my-4/leading-8), neutral zinc inline code
 * pills and blockquote borders (cyan is reserved for interactive links —
 * the monochrome doctrine), denser lists.
 */
const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, className }) => {
  return (
    <div className={`text-ui-base leading-relaxed text-zinc-300 prose prose-invert prose-sm max-w-none ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
        components={{
          pre: ({ children }) => (
            <pre className="my-3 rounded-bubble bg-black/50 border border-hairline p-3 overflow-x-auto text-ui-sm font-mono leading-relaxed text-zinc-300 whitespace-pre-wrap [&_code]:rounded-none [&_code]:border-0 [&_code]:bg-transparent [&_code]:px-0 [&_code]:py-0">
              {children}
            </pre>
          ),
          code: ({ className: codeClassName, children, ...props }) => {
            // Fenced blocks carry a language-* class and live inside the
            // boxed <pre>; bare backticks are neutral zinc pills.
            //
            // The language test is NOT enough on its own: a fence written
            // without a language (which is what the models usually emit)
            // carries no `language-*` class, fell through to the inline pill,
            // and an INLINE element paints its background once per line box --
            // so a nine-line block arrived as nine stacked grey bands inside
            // the pre's own box. The pre neutralises any code inside it from
            // here, so the pill styling can only ever reach real inline code.
            const isBlock = /language-/.test(String(codeClassName || ''));
            if (isBlock) {
              return (
                <code className="font-mono text-zinc-300" {...props}>{children}</code>
              );
            }
            return (
              <code
                {...props}
                className="rounded-control break-inside-avoid border border-hairline bg-white/[0.06] px-1 py-0.5 font-mono text-[12.5px] text-zinc-200 whitespace-nowrap"
              >
                {children}
              </code>
            );
          },
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto overscroll-x-contain custom-scrollbar">
              {/* w-max, not w-full: a wide table keeps its natural columns and
                  OVERFLOWS the wrapper (scrollable, with the always-visible
                  custom-scrollbar thumb) instead of shrinking cells until the
                  extra columns vanish — the "many columns don't display" bug.

                  Scroll container, NOT a box: the reference table is a header
                  row plus hairline separators with no outer border, and a
                  rounded border around it reads as a widget rather than as
                  tabular prose. The overflow wrapper stays; its frame goes. */}
              <table className="w-max min-w-full text-left text-ui-sm border-collapse tabular-nums">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            // NORMAL CASE, body size, weight 500 — the reference table header is
            // NOT an uppercase micro-label. The plan specified
            // `text-ui-2xs uppercase tracking-wider` on the strength of
            // index.css:250 ("reserved for table headers"), but that token's one
            // real use is a `kbd` micro-label (index.css:1139) and the reference
            // header reads as body-weight emphasis, not a shrunken label. Sizing
            // it down made a 5-row table's header the smallest thing on screen.
            <th className="whitespace-nowrap border-b border-zinc-700 bg-zinc-800 px-3 py-1.5 text-ui-caption font-medium text-zinc-200 text-left">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border-b border-zinc-700/60 px-3 py-1.5 text-ui-caption text-zinc-300 align-middle leading-snug">{children}</td>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-line pl-3.5 text-zinc-400 italic">{children}</blockquote>
          ),
          h1: ({ children }) => <h1 className="mt-5 mb-2.5 text-lg font-semibold text-zinc-100">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-5 mb-2.5 text-ui-lg font-semibold text-zinc-100">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-4 mb-2 text-ui-base font-semibold text-zinc-100">{children}</h3>,
          hr: () => <hr className="my-4 border-hairline" />,
          p: ({ children }) => <p className="my-3 leading-[1.65] text-zinc-300">{children}</p>,
          ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5 text-zinc-300 marker:text-zinc-600">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-5 text-zinc-300 marker:text-zinc-600">{children}</ol>,
          li: ({ children }) => <li className="leading-[1.65]">{children}</li>,
          em: ({ children }) => <em className="italic text-zinc-200">{children}</em>,
          strong: ({ children }) => <strong className="font-bold text-zinc-50">{children}</strong>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 underline">{children}</a>
          ),
        }}
      >
        {prepareMath(content || '')}
      </ReactMarkdown>
    </div>
  );
};

export default memo(MarkdownRenderer);
