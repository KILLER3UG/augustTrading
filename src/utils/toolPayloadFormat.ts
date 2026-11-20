/**
 * Pure formatting helpers for tool call payloads and markdown code fences.
 * Keeps pretty-printing, language detection, and safe preview truncation
 * deterministic and unit-testable outside React components.
 */

export type PayloadLanguage = 'JSON' | 'text';

export interface FormattedToolPayload {
    /** Display text (pretty-printed when valid JSON). */
    text: string;
    /** Detected format badge. */
    language: PayloadLanguage;
    /** Total line count of the formatted payload. */
    lineCount: number;
    /** True when the preview was truncated to `maxLines`. */
    truncated: boolean;
    /** Preview text bounded to `maxLines` when truncated; otherwise equals `text`. */
    preview: string;
}

const DEFAULT_PREVIEW_LINES = 18;

/**
 * Detect whether a payload string is JSON (object or array) and pretty-print
 * it with 2-space indentation so Level 2 tool disclosures read cleanly instead
 * of dumping a single wrapped line.
 */
export function formatToolPayload(raw: string, maxLines: number = DEFAULT_PREVIEW_LINES): FormattedToolPayload {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { text: '', language: 'text', lineCount: 0, truncated: false, preview: '' };
    }

    let formatted = trimmed;
    let language: PayloadLanguage = 'text';

    const first = trimmed[0];
    if (first === '{' || first === '[') {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            formatted = JSON.stringify(parsed, null, 2);
            language = 'JSON';
        } catch {
            // Keep raw text when payload looks JSON-like but is clipped or non-JSON.
        }
    }

    const lines = formatted.split('\n');
    const safeLimit = Math.max(1, Math.floor(maxLines));
    const truncated = lines.length > safeLimit;
    const preview = truncated ? lines.slice(0, safeLimit).join('\n') : formatted;

    return {
        text: formatted,
        language,
        lineCount: lines.length,
        truncated,
        preview,
    };
}

/**
 * Extract a clean display label from a markdown `language-*` class name
 * (e.g. `"language-bash"` -> `"bash"`, `"language-typescript"` -> `"typescript"`).
 * Returns `null` when no language tag was specified.
 */
export function parseCodeFenceLanguage(className?: string): string | null {
    if (!className) return null;
    const match = /\blanguage-([a-zA-Z0-9_+#.-]+)/.exec(className);
    if (!match?.[1]) return null;
    return match[1].toLowerCase();
}
