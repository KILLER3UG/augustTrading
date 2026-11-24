/**
 * Google Gemini REST (AI Studio / generativelanguage).
 * POST {base}/models/{model}:generateContent?key=
 * POST {base}/models/{model}:streamGenerateContent?alt=sse&key=
 * GET  {base}/models?key=
 */

import { TokenUsage } from './tokenUsage';
import {
    geminiThinkingParams,
    GOOGLE_GEMINI_DEFAULT_BASE,
    isGoogleGeminiBaseUrl,
} from '../../shared/providerRequestPolicy.cjs';

export { GOOGLE_GEMINI_DEFAULT_BASE };

export type GeminiRole = 'user' | 'model';

export interface GeminiPart {
    text?: string;
    inlineData?: { mimeType: string; data: string };
    thought?: boolean;
}

export interface GeminiContent {
    role: GeminiRole;
    parts: GeminiPart[];
}

export interface GeminiGenerateBody {
    contents: GeminiContent[];
    systemInstruction?: { parts: Array<{ text: string }> };
    generationConfig: {
        temperature: number;
        maxOutputTokens: number;
        responseMimeType?: string;
        thinkingConfig?: { includeThoughts: boolean; thinkingBudget?: number };
    };
}

export const isGoogleApiFormat = (format?: string): boolean => format === 'google';

export const usesGoogleGeminiDiscovery = (baseUrl: string, format?: string): boolean =>
    isGoogleApiFormat(format) || isGoogleGeminiBaseUrl(baseUrl);

export const geminiModelId = (model: string): string =>
    (model || '').trim().replace(/^models\//, '');

export const googleModelsUrl = (baseUrl: string, apiKey: string): string =>
    `${(baseUrl || '').replace(/\/+$/, '')}/models?key=${encodeURIComponent(apiKey)}`;

export const googleGenerateUrl = (baseUrl: string, model: string, apiKey: string, stream = false): string => {
    const base = (baseUrl || '').replace(/\/+$/, '');
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    const query = stream
        ? `alt=sse&key=${encodeURIComponent(apiKey)}`
        : `key=${encodeURIComponent(apiKey)}`;
    return `${base}/models/${encodeURIComponent(geminiModelId(model))}:${action}?${query}`;
};

const contentToText = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((part: { type?: string; text?: string }) => part?.type === 'text' && typeof part.text === 'string')
        .map((part: { text: string }) => part.text)
        .join('');
};

const toGeminiParts = (content: unknown): GeminiPart[] => {
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    if (!Array.isArray(content)) return [];
    const parts: GeminiPart[] = [];
    for (const part of content as Array<{ type?: string; text?: string; image_url?: { url?: string } }>) {
        if (part?.type === 'text' && part.text) {
            parts.push({ text: part.text });
            continue;
        }
        const url = part?.image_url?.url || '';
        const comma = url.indexOf(',');
        if (url.startsWith('data:') && comma !== -1) {
            const header = url.slice(5, comma);
            const mimeMatch = header.match(/^image\/(png|jpeg|jpg|webp|gif)\b/i);
            const mimeType = mimeMatch
                ? `image/${mimeMatch[1].toLowerCase() === 'jpg' ? 'jpeg' : mimeMatch[1].toLowerCase()}`
                : 'image/png';
            parts.push({ inlineData: { mimeType, data: url.slice(comma + 1) } });
        } else if (url) {
            parts.push({ text: `[image: ${url}]` });
        }
    }
    return parts;
};

const toGeminiRole = (role: string): GeminiRole =>
    role === 'assistant' || role === 'model' ? 'model' : 'user';

export const chatMessagesToGemini = (
    messages: Array<{ role: string; content: unknown }>,
    options?: { maxTokens?: number; temperature?: number; jsonMode?: boolean; model?: string; reasoningEffort?: string },
): GeminiGenerateBody => {
    const systemBits: string[] = [];
    const contents: GeminiContent[] = [];
    for (const message of messages) {
        if (message.role === 'system') {
            const text = contentToText(message.content).trim();
            if (text) systemBits.push(text);
            continue;
        }
        const parts = toGeminiParts(message.content);
        if (parts.length === 0) continue;
        const role = toGeminiRole(message.role);
        const last = contents[contents.length - 1];
        if (last && last.role === role) {
            last.parts.push(...parts);
        } else {
            contents.push({ role, parts });
        }
    }
    if (contents.length === 0) {
        contents.push({ role: 'user', parts: [{ text: systemBits.join('\n\n') || ' ' }] });
        systemBits.length = 0;
    } else if (contents[0].role !== 'user') {
        contents.unshift({ role: 'user', parts: [{ text: 'Continue.' }] });
    }

    const model = (options?.model || '').toLowerCase();
    const maxOutputTokens = options?.maxTokens ?? 4096;
    const body: GeminiGenerateBody = {
        contents,
        generationConfig: {
            temperature: options?.temperature ?? 0.7,
            maxOutputTokens,
        },
    };
    if (systemBits.length > 0) {
        body.systemInstruction = { parts: [{ text: systemBits.join('\n\n') }] };
    }
    if (options?.jsonMode) {
        body.generationConfig.responseMimeType = 'application/json';
    }
    // The transport applies the SAME function on the canonical path; a second
    // hand-written budget ladder here is how the two drift apart, and it also
    // let a 16384 thinking budget onto a call allowed 4096 output tokens.
    const thinking = geminiThinkingParams(options?.jsonMode, model, options?.reasoningEffort, maxOutputTokens);
    if (thinking) body.generationConfig.thinkingConfig = thinking;
    return body;
};

export const parseGeminiResponse = (data: unknown): { text: string; reasoning: string } => {
    const texts: string[] = [];
    const thoughts: string[] = [];
    const candidates = (data as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> })?.candidates;
    if (Array.isArray(candidates)) {
        for (const candidate of candidates) {
            const parts = candidate?.content?.parts;
            if (!Array.isArray(parts)) continue;
            for (const part of parts) {
                if (typeof part?.text !== 'string' || !part.text) continue;
                if (part.thought) thoughts.push(part.text);
                else texts.push(part.text);
            }
        }
    }
    return { text: texts.join('\n').trim(), reasoning: thoughts.join('\n').trim() };
};

export const extractGeminiUsage = (data: unknown): TokenUsage | null => {
    if (!data || typeof data !== 'object') return null;
    const meta = (data as { usageMetadata?: Record<string, unknown> }).usageMetadata;
    if (!meta || typeof meta !== 'object') return null;
    const prompt = Number(meta.promptTokenCount ?? 0) || 0;
    const completion = Number(meta.candidatesTokenCount ?? 0) || 0;
    const total = Number(meta.totalTokenCount ?? prompt + completion) || 0;
    if (!prompt && !completion && !total) return null;
    return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total || prompt + completion,
    };
};
