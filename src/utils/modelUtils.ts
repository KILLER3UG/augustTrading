/**
 * modelUtils — Shared model-related heuristics.
 *
 * Kept in one place so a new vision-capable model only needs a single edit.
 */

/**
 * Vision capability check: prefers explicit per-model `inputTypes.image` or
 * provider `vision` metadata when supplied, falling back to known multimodal
 * model-family heuristics only when metadata is absent.
 */
export function isVisionModel(
    modelId: string,
    capabilities?: { vision?: boolean; inputTypes?: { text?: boolean; image?: boolean } },
): boolean {
    if (typeof capabilities?.inputTypes?.image === 'boolean') return capabilities.inputTypes.image;
    if (typeof capabilities?.vision === 'boolean') return capabilities.vision;
    const m = modelId.toLowerCase();
    return m.includes('vision')
        || m.includes('-vl')
        || m.includes('vl-')
        || m.includes('llama-4')
        || m.includes('gpt-4o')
        || m.includes('gpt-4.1')
        || m.includes('gpt-5')
        || m.includes('claude-3')
        || m.includes('claude-4')
        || m.includes('claude-sonnet-4')
        || m.includes('claude-opus-4')
        || m.includes('glm-4.5v')
        || m.includes('glm-4.6v')
        || m.includes('pixtral')
        || m.includes('gemini');
}
