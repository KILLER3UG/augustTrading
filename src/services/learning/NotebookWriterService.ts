/**
 * NotebookWriterService — the AI half of the Trader Notebook.
 *
 * After every closed trade's post-mortem, the harness asks a model to decide
 * what the notebook needs. The model FIRST reads the current notebook index
 * (`getMemoryFilesIndex` — folders, files, excerpts) and then chooses:
 *   - "skip"    → the lesson is already covered or nothing new emerged —
 *                 nothing is written (the notebook never accumulates junk).
 *   - "append"  → an existing file already covers this topic — the note
 *                 becomes a NEW SECTION on that file.
 *   - "create"  → new topic: a new file; a new folder only when the topic
 *                 family has no home.
 * The user keeps full manual control of the notebook alongside.
 */

import { ProviderConfig } from '../../types/provider';
import { getPrompt } from '../infrastructure/PromptOverrideService';
import { getQuickResponse } from '../providers/GenericAnalysisService';
import { extractAndParseJson } from '../../utils/jsonUtils';
import { getMemoryFilesIndex, ModelNote } from './MemoryFilesService';

// Exported so `constants/promptRegistry.ts` can IMPORT the built-in default instead of
// restating it: the registry's copy used to be shorter than the real prompt and was
// missing the line that forbids writing into `skills/`.
export const CHAT_NOTE_FALLBACK = `The user asked you to save something to their trader notebook — markdown files the AI ensemble reads before EVERY future analysis. Decide what the notebook needs.

The CURRENT NOTEBOOK block below lists every folder and file with a short excerpt. READ IT FIRST.

DECIDE:
- "skip" — when the request has no concrete, reusable lesson/rule/playbook, or it is already fully covered by an existing file.
- "append" — when an existing file already covers this topic: your content becomes a NEW SECTION on that file (own ## heading, --- separated). Never repeat what that file already says.
- "create" — when the topic is new: a new file. A new folder ONLY when the topic family has no home (market-conditions / rules / lessons are the usual homes). trader-diary is reserved for the automatic diary — never write there.
- Never write to skills/ — the harness creates skills only after a cluster of similar trades has evidence.

Content rules:
- Actionable and TIMELESS: what to REPEAT or AVOID next time the same situation appears. No PnL, no dates, no trade ids.
- Written in first person ("When I…", "I will…") as the trader's own lesson.
- 10-40 lines of clean markdown per section: a short heading, 3-8 bullet points, optional "Trigger" / "Invalidates" lines.
- If the user references the CONTEXT below (their most recent analysis), write about THAT setup.

Output ONLY valid JSON with exactly these fields:
{
  "decision": "skip" | "append" | "create",
  "folder": "existing-or-new-kebab-folder",
  "fileName": "short-kebab-name.md",
  "content": "markdown"
}`;

/**
 * Chat quick-save: the user asks mid-conversation ("save this to the
 * notebook") and the model decides skip/append/create against the real
 * current notebook. Returns null on skip or unparseable replies.
 */
export const writeNotebookNoteFromRequest = async (
    request: string,
    context: string,
    config: ProviderConfig
): Promise<ModelNote | null> => {
    const system = `${getPrompt('notebook.chat_note', CHAT_NOTE_FALLBACK)}

CURRENT NOTEBOOK (folders + files + excerpts — read before deciding):
${getMemoryFilesIndex()}`;
    const userMessage = `USER REQUEST:\n${request}${context ? `\n\nCONTEXT (the user's most recent analysis in this conversation):\n${context}` : ''}`;

    const raw = await getQuickResponse(config, userMessage, [], system);
    const parsed = extractAndParseJson(raw) as Partial<ModelNote> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.decision === 'skip') return null;
    const folder = typeof parsed.folder === 'string' ? parsed.folder.trim() : '';
    const fileName = typeof parsed.fileName === 'string' ? parsed.fileName.trim() : '';
    const content = typeof parsed.content === 'string' ? parsed.content.trim() : '';
    if (!folder || !fileName || !content) return null;
    return {
        decision: parsed.decision === 'append' ? 'append' : 'create',
        folder,
        fileName,
        content,
    };
};

