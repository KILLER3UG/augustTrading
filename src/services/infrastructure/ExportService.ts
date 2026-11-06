/**
 * ExportService - Cross-platform data export
 * Uses Capacitor Filesystem + Share API for Android/iOS, blob download for web
 */

import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

/**
 * Check if running in Capacitor (native APK/iOS)
 */
const isNativePlatform = (): boolean => {
    try {
        return Capacitor.isNativePlatform();
    } catch {
        return false;
    }
};

/**
 * Export data as a downloadable/shareable JSON file
 * 
 * On Android/iOS: Writes to cache directory then shares the file
 * On Web: Creates a blob download
 * 
 * @param data - The data object to export
 * @param filename - The filename (without path)
 * @returns Promise resolving to success status
 */
export const exportTextAsFile = async (
    content: string,
    filename: string
): Promise<{ success: boolean; error?: string }> => {
    if (isNativePlatform()) {
        return exportNative(content, filename);
    }
    return exportWeb(content, filename);
};

export const exportDataAsFile = async (
    data: any,
    filename: string
): Promise<{ success: boolean; error?: string }> => {
    const jsonContent = JSON.stringify(data, null, 2);

    if (isNativePlatform()) {
        return exportNative(jsonContent, filename);
    } else {
        return exportWeb(jsonContent, filename);
    }
};

/**
 * Native export using Capacitor Filesystem + Share API
 * Writes file to cache directory first, then shares via file URI
 * This avoids Android's intent size limit (~1MB) that causes crashes
 */
const exportNative = async (
    content: string,
    filename: string
): Promise<{ success: boolean; error?: string }> => {
    try {
        console.log('[ExportService] Writing file to cache directory...');

        // Step 1: Write file to cache directory
        const result = await Filesystem.writeFile({
            path: filename,
            data: content,
            directory: Directory.Cache,
            encoding: Encoding.UTF8,
        });

        console.log('[ExportService] File written:', result.uri);

        // Step 2: Share the file URI instead of raw text
        // This avoids the intent size limit that crashes the app
        try {
            await Share.share({
                title: `August Backup`,
                url: result.uri, // Share file URI, not text
                dialogTitle: 'Save or Share Your Backup',
            });

            console.log('[ExportService] Share dialog opened successfully');
            return { success: true };
        } catch (shareError: any) {
            // Check for share cancellation (not an error)
            if (shareError.message?.includes('cancel') || shareError.message?.includes('abort') || shareError.message?.includes('dismiss')) {
                return { success: true }; // User cancelled, not an error
            }

            // If share fails, try to copy to downloads as fallback
            console.warn('[ExportService] Share failed, trying fallback copy:', shareError);
            return await fallbackCopyToDownloads(content, filename);
        }
    } catch (error: any) {
        console.error('[ExportService] Native export failed:', error);

        // Final fallback: Try text-based share with truncation warning
        return {
            success: false,
            error: `Export failed: ${error.message || 'Unknown error'}. Try reducing trade log size.`,
        };
    }
};

/**
 * Fallback: Copy content to clipboard with instructions
 */
const fallbackCopyToDownloads = async (
    content: string,
    filename: string
): Promise<{ success: boolean; error?: string }> => {
    try {
        // Try to write to Documents directory (more accessible)
        await Filesystem.writeFile({
            path: `Download/${filename}`,
            data: content,
            directory: Directory.ExternalStorage, // Public external storage
            encoding: Encoding.UTF8,
            recursive: true,
        });

        return {
            success: true,
            error: `Saved to Downloads folder: ${filename}`
        };
    } catch (downloadError: any) {
        console.error('[ExportService] Fallback also failed:', downloadError);

        // Last resort: Copy to clipboard
        try {
            if (navigator.clipboard && content.length < 1000000) {
                await navigator.clipboard.writeText(content);
                return {
                    success: true,
                    error: 'Backup copied to clipboard. Paste into a text file to save.'
                };
            }
        } catch (clipError) {
            console.error('[ExportService] Clipboard fallback failed:', clipError);
        }

        return {
            success: false,
            error: `Export failed. Data may be too large. Try exporting less data.`,
        };
    }
};

/**
 * Web export using blob download
 */
const exportWeb = async (
    content: string,
    filename: string
): Promise<{ success: boolean; error?: string }> => {
    try {
        console.log('[ExportService] Using blob download (Web)');

        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('[ExportService] Web download initiated');
        return { success: true };
    } catch (error: any) {
        console.error('[ExportService] Web export failed:', error);
        return {
            success: false,
            error: `Export failed: ${error.message || 'Unknown error'}`,
        };
    }
};

/**
 * Check if the Share API is available
 */
export const canShare = async (): Promise<boolean> => {
    if (!isNativePlatform()) {
        return true; // Web can always use blob download
    }

    try {
        const result = await Share.canShare();
        return result.value;
    } catch {
        return false;
    }
};


import { getAllKeys, getPreferenceObject, setPreference, setPreferenceObject, PREF_KEYS } from './PreferencesService';
import { readStore } from './storeBackend';
import { getActiveUsername } from '../../utils/activeUser';
import { ProviderConfig } from '../../types/provider';
import { validateProviderUrl } from '../../utils/providerUrlValidation';
import { saveProviderConfigs } from './ProviderConfigService';

/** The one transform every exported value passes through. It is allowed to make
 *  a backup SMALLER or LESS REVEALING than the live store — never to change what
 *  the owner would read back on this device. */
const redactPreferenceValue = (key: string, value: unknown): unknown => {
    if (key === FORGED_TOOLS_PREF_KEY) return redactForgedTools(value);
    // Chat transcripts carry base64 screenshots; they travel as a stub, the rest
    // of the session verbatim (`stripChatSessionImages`).
    if (key.startsWith('trade_chat_sessions_v1')) return stripChatSessionImages(value);
    if (key !== PREF_KEYS.PROVIDER_CONFIGS || !Array.isArray(value)) return value;
    return value.map((provider: ProviderConfig) => ({
        ...provider,
        apiKey: '',
    }));
};

/**
 * Redact secrets from forged desk tools before they leave the device, same
 * contract as the provider-config redaction above. toolForge deliberately
 * supports static `Authorization`/`Cookie` headers (its validator only
 * rejects token-looking values in NON-auth headers), so a user's bearer
 * token otherwise shipped in every exported backup in plaintext on the same
 * file where provider keys are correctly blanked. Header NAMES matching the
 * secret list are dropped entirely — a half-redacted header value would
 * still fail the remote's auth and invites "just re-add it" edits.
 */
const FORGED_TOOLS_PREF_KEY = 'desk_tools_forged_v1';
const SECRET_HEADER_NAME_RE = /authorization|cookie|api-?key|token/i;
const redactForgedTools = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((tool) => {
        if (!tool || typeof tool !== 'object' || !tool.headers || typeof tool.headers !== 'object') return tool;
        const headers: Record<string, string> = { ...tool.headers };
        for (const name of Object.keys(headers)) {
            if (SECRET_HEADER_NAME_RE.test(name)) delete headers[name];
        }
        return { ...tool, headers };
    });
};

/**
 * Namespaces whose OWNER talks to `localStorage` directly, bypassing the
 * Preferences abstraction — verified at each writer, not inferred from the
 * allow-list:
 *
 *   profile_memory_v1_<user>      services/learning/profileMemory.ts:80
 *   learning_rules_v2_<user>      services/infrastructure/StorageService.ts:36,97
 *   agents_{bots,groups,teams}_v1_<user>  services/agents/agentRoster.ts:120
 *   model_performance_data        services/backtesting/ModelPerformanceService.ts:315
 *   rolling_window_data           services/backtesting/ModelPerformanceService.ts:774
 *   model_confidence_calibration  services/backtesting/ModelPerformanceService.ts:1236
 *   confidence_calibration        (the legacy key the line above migrates FROM)
 *   confluence_historical_stats   services/analysis/TimeframeConfluenceService.ts:206
 *
 * The learning loop added four more that bypass Preferences the same way,
 * all of them invisible to a backup before this list knew them. The symbol is
 * named rather than the line for the ones that move as their module is edited:
 *   memory_amendments_v1          services/learning/memoryAmendments.ts (KEY)
 *   august_harness_lessons_v1     services/learning/harnessLessons.ts (STORAGE_KEY)
 *   trader_learning_v1:<user>     services/learning/traderLearner.ts (TOGGLE_KEY)
 *   trader_learner_counter_v1:<user> services/learning/traderLearner.ts (COUNTER_KEY)
 *
 * The two scoped keys build `${KEY}:${username}` — which is why the matcher
 * below honours both separators.
 *
 * `trader_learning_v1:<user>` is the sharpest of them: it holds the trader's
 * "learner OFF" CONSENT, whose default is on (`isTraderLearningEnabled` reads
 * `!== '0'`), so a restore that missed it did not lose a cache — it silently
 * re-enabled an LLM pass the user had switched off.
 *
 * Stores whose writers are deleted leave BOTH lists. Keys no code reads are not
 * the trader's data, and a backup that carries them forever makes it look like
 * they are. The RESTORE list is the exception and keeps a dated note where it
 * does: a backup taken by an OLDER build still names those keys, and a restore
 * retains those historical values without reviving their deleted consumers.
 *
 * On web this is the same store `PreferencesService` falls back to, so nothing
 * notices. On NATIVE they are two different places — Capacitor Preferences is
 * SharedPreferences/UserDefaults — and that broke backups in both directions:
 * reading them with `getPreferenceObject` found nothing, so the trader's
 * learning rules, profile memory, bot roster and calibration silently never
 * left the device; and writing them back through Preferences put them where no
 * reader looks. So the same list drives the export read and the restore mirror.
 *
 * Deliberately NOT every key: the WebView's storage quota is the one this app
 * has already been bitten by (see utils/memoryBudget), so shadow-copying keys
 * that Preferences genuinely owns would spend eviction-prone bytes on a copy
 * nothing reads. `scripts/check-contracts.cjs` › the raw-storage section keeps
 * two halves of this honest as stores are added: every prefix on the sweep list
 * must still name a key some module holds, and every prefix on the sweep list
 * must also be on the restore allow-list (the asymmetry that used to export one
 * store's bytes and refuse to put them back). What NO gate checks is the third
 * case — a NEW `localStorage.setItem` that lands in neither list, because being
 * listed is a judgement about which owner reads the key, not a property a
 * scanner can infer.
 */
const RAW_LOCAL_STORAGE_PREFIXES: readonly string[] = [
    'profile_memory_v1',
    'learning_rules_v2',
    'agents_bots_v1',
    'agents_groups_v1',
    'model_performance_data',
    'rolling_window_data',
    'model_confidence_calibration',
    'confidence_calibration',
    'confluence_historical_stats',
    'memory_amendments_v1',
    'august_harness_lessons_v1',
    'trader_learning_v1',
    'trader_learner_counter_v1',
    'august_starred_models_v1',
    // Nav-rail width preference (Stage 2 Phase 2). A layout preference, not
    // trading data — but it is read straight from localStorage, so on NATIVE
    // it lives in a different place from the Preferences-owned keys above, and
    // leaving it out means a restored backup silently drops the user's rail.
    'nav_rail_width_v1',
    // Right-panel width preference (Stage 2 Phase 2, the shared contract in
    // hooks/useRightPanel): `right_panel_width_v1_<surface>`, one per surface.
    // Same reasoning as the rail width — the user dragged the panel there, and
    // a restored backup that silently resets every panel to its default is the
    // same lost-layout annoyance. Plain numeric strings; they round-trip.
    'right_panel_width_v1',
    // The other dragged column (hooks/useColumnResize): the shell rail, in px.
    // Same reasoning — a restored backup that silently
    // resets it is lost layout, not lost data, but it is still the owner's
    // choice disappearing. (The order book's key left with the v3 shell, which
    // un-pinned that column; `scripts/check-contracts.cjs` fails the export list
    // if a key like that outlives its writer again.)
    'nav_rail_expanded_px_v1',
    // The trading surface, measured before registering (owners verified: each
    // writes `localStorage` directly and never goes through PreferencesService):
    //   watchService.ts:61 (10 watches), levelWatchService.ts:140/167 (10 arms /
    //   200 hits), chartDrawings.ts:121/187 (40 drawings × 200 points, per symbol
    //   and per session), chatStore.ts:160 (a plain id string), chatSessions.ts:199
    //   (12 sessions × 60 entries — see the image strip below), toolForge.ts:365
    //   (already redacted), checklist.ts:51, TradingChart.tsx:112 (≤ ~90 bytes),
    //   and harnessSettings.ts:79 — which is a RAW owner too, not a Preferences
    //   one: it was assumed "covered via Preferences" and a real export with an
    //   empty Preferences store proved it was not in the backup at all.
    // The Q4 ruling (owner, 2026-10-20) moved the five
    // restore-listed-but-not-raw namespaces INTO the backup, together with the
    // auto-apply policy. They are small; the cost is a few hundred bytes, and
    // a restore that silently drops the trader's motion preference, open
    // threads, last user or withheld-reasoning bin is the exact half-migration
    // this list exists to prevent. The three crash breadcrumbs
    // (lastPromiseError, lastGlobalError, lastCrashError) stay OUT — telemetry,
    // not the trader's data.
    'trade_sidebar_open_v1',
    'agent_threads_opened_v1',
    'desk_idle_motion_v1',
    'thinking_leak_bin_v1',
    'last_active_user',
    'approval_rules_v1',
    // A plain session-id string. It used to be excluded because the sweep
    // JSON-parses raw values and the mirror would have written `"s-1"` where
    // the owner reads `s-1`. The raw-string envelope below carries it (and the
    // plain flags above) without changing the owner's bytes.
    'trade_chat_active_v1',
    'trade_watches_v1',
    'trade_declines_v1',
    'trade_level_arms_v1',
    'trade_level_hits_v1',
    'trade_drawings_v1',
    'trade_session_drawings_v1',
    // NOT 'trade_chat_active_v1': chatStore.ts:160 stores a PLAIN session-id
    // string, which this sweep cannot JSON.parse (so it exports nothing) and a
    // mirrored `JSON.stringify` would write as `"s-1"` where the owner reads the
    // bare `s-1`. Registering it would corrupt the very pointer it backs up — it
    // needs a raw-string envelope in the backup format first.
    'trade_chat_sessions_v1',
    // The real tool output behind an expanded transcript row
    // (`services/trade/toolPayloadStore.ts`), written straight through
    // localStorage once per tool call. A raw owner like the rest: leaving it out
    // would mean a restored backup shows every tool row with its payload gone.
    'trade_tool_payloads_v1',
    'desk_tools_forged_v1',
    'trading_checklist_v1',
    'trade_tf_bar_v1',
    'harness_settings_v1',
    // The signal ledger (services/signals/signalLedger.ts): emitted calls and
    // their resolutions, `signal_ledger_v1:<user>`. Raw owner like the rest —
    // leaving it out would make a restored profile forget every call the desk
    // was graded on while the journal came back.
    'signal_ledger_v1',
    // The tracked-position store (services/tracking/positionStore.ts). A
    // dedicated backend, but the restore path writes the same keys through
    // Preferences/localStorage; without these prefixes a restored profile
    // would forget every open plan and its post-mortem.
    'tracked_positions_v1',
    'tracked_diagnoses_v1',
    'tracked_diagnosis_queue_v1',
];

/** The cap for a SMALL raw-localStorage store. The notebook's own hard ceiling is
 *  2 MB (`utils/memoryBudget.ts:38`) and the WebView origin quota is SHARED, so a
 *  single key gets a fraction of it — and a store that cannot fit even after its
 *  images are stripped is SKIPPED and reported, never truncated in silence.
 *
 *  NOT a blanket ceiling any more: the chat store outgrew browser storage (its
 *  desktop file backend allows 32 MiB), so the stores listed in EXPORT_KEY_CAPS
 *  carry their own; this number is what the remaining preference blobs get.
 *
 *  Scoped to the namespaces listed below ON PURPOSE: `memory_files_v1_<user>` is
 *  legitimately allowed to reach 2 MB, so a blanket cap here would drop the
 *  notebook from backups and make this "guard" the data-loss bug it exists to
 *  prevent. */
export const EXPORT_RAW_KEY_CAP_BYTES = 512 * 1024;

/** Per-store ceilings, chosen from each owner's OWN bound so a normal backup is
 *  never trimmed (measured 2026-10-05, recorded in docs/plan/open-items.md):
 *
 *  - chat sessions 32 MiB — the store's own file ceiling
 *    (`electron/storeFs.cjs` MAX_VALUE_BYTES), and above the desktop byte budget
 *    (`chatSessions.storedCharsBudget`, 24 M chars). Entries are no longer
 *    count-capped (owner ruling, 2026-10-27); images are stripped first.
 *  - session drawings 1 MB — `chartDrawings.ts:54-55` bounds a coin at 40 drawings ×
 *    200 points (≈180 KB), and one key holds EVERY coin traded in that session;
 *    a normal session is ~10 KB.
 *  - forged tools 256 KB — a tool row is ~1-1.5 KB (`toolForge.ts:18-47`) and nothing
 *    bounds the count; 256 KB is ~170 tools.
 *  - checklist 64 KB — ~90 bytes per item (`checklist.ts:9-11`); ~700 items.
 *
 *  A cap is a ceiling on what the BACKUP may carry, never on what the device keeps:
 *  an over-cap store is left out and named, and its live bytes are untouched. */
const EXPORT_KEY_CAPS: ReadonlyArray<{ prefix: string; bytes: number }> = [
    // The chat store's own file ceiling is 32 MiB on desktop; a backup must be
    // able to carry what the store can hold (chat images are stripped first).
    // The shared 512 KB raw-key cap is for small preference blobs, not this.
    { prefix: 'trade_chat_sessions_v1', bytes: 32 * 1024 * 1024 },
    // The real tool output behind an expanded transcript row. A side store on
    // purpose: payloads inside `trade_chat_sessions_v1` entries would push the
    // transcripts themselves out of the chat-session ceiling. Capped below the
    // store's own 1,000,000-char ceiling so a payload-heavy session cannot take
    // the whole backup either — the live key is untouched when over.
    { prefix: 'trade_tool_payloads_v1', bytes: 256 * 1024 },
    { prefix: 'trade_session_drawings_v1', bytes: 1024 * 1024 },
    { prefix: 'trade_session_model_v1', bytes: 1024 * 1024 },
    { prefix: 'desk_tools_forged_v1', bytes: 256 * 1024 },
    { prefix: 'trading_checklist_v1', bytes: 64 * 1024 },
    // The ledger's own store cap is 200 KiB (`LEDGER_BYTE_CAP`); the backup cap
    // sits just above it so a normally-pruned store is never left out, and a
    // corrupt oversized one is named rather than silently truncated.
    { prefix: 'signal_ledger_v1', bytes: 256 * 1024 },
    // The tracker's own caps are 240 path points + 60 context points per
    // position and 100 closed positions; 8 MiB carries a full store without
    // truncating, while still bounding a runaway backup.
    { prefix: 'tracked_positions_v1', bytes: 8 * 1024 * 1024 },
    { prefix: 'tracked_diagnoses_v1', bytes: 8 * 1024 * 1024 },
    { prefix: 'tracked_diagnosis_queue_v1', bytes: 256 * 1024 },
];

/** The placeholder that replaces an image payload in an EXPORT COPY. Text, order
 *  and metadata are untouched; the live key is never written with this. */
interface ExportedImageStub { bytes: number; mime: string }

const IMAGE_MIME_RE = /^data:([^;,]+)/;

/** `trade_chat_sessions_v1_<user>` is 12 sessions × 60 entries bounded by COUNT,
 *  not bytes, and one entry can carry a 1.2 MB base64 screenshot
 *  (`chatSessions.ts:98`). Backing it whole would put a hundred-megabyte blob in
 *  one backup against a shared quota, so images travel as a stub saying they
 *  existed. Applies to the exported value only. */
const stripChatSessionImages = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map(session => {
        if (!session || typeof session !== 'object') return session;
        const s = session as { entries?: unknown };
        if (!Array.isArray(s.entries)) return session;
        return {
            ...session,
            entries: s.entries.map(entry => {
                if (!entry || typeof entry !== 'object') return entry;
                const e = entry as { image?: unknown; imageOmitted?: unknown };
                if (typeof e.image !== 'string' || !e.image) return entry;
                const stub: ExportedImageStub = {
                    bytes: e.image.length,
                    mime: IMAGE_MIME_RE.exec(e.image)?.[1] ?? 'image',
                };
                const { image: _image, ...rest } = e as { image?: unknown };
                return { ...rest, imageOmitted: e.imageOmitted ?? stub };
            }),
        };
    });
};

/**
 * Is this key owned by a store that talks to `localStorage` directly?
 *
 * Exported (narrow, predicate-only) so `scripts/check-contracts.cjs` can assert
 * the invariant against the REAL matcher instead of a second copy
 * of the list that would drift from it.
 *
 * Two scoping conventions are in the tree, so both are honoured: `<ns>_<user>`
 * (the rosters, the drawing/level/watch stores) and `<ns>:<user>` (the
 * learning-loop counters, whose writers build `${KEY}:${username}`). Matching
 * only the first one left every `:`-scoped store exported-but-not-mirrored —
 * the same mobile data loss as being absent from the list entirely.
 */
export const isRawLocalStorageKey = (key: string): boolean =>
    RAW_LOCAL_STORAGE_PREFIXES.some(p =>
        key === p || key.startsWith(`${p}_`) || key.startsWith(`${p}:`));

/**
 * A raw localStorage value that is not JSON — a username, a session id, a
 * `'0'`/`'1'` flag. The sweep cannot parse it and the generic mirror would
 * quote it (`"s-1"`) where the owner reads the bare bytes. The envelope keeps
 * the exact string without pretending it is a JSON value.
 *
 * It is a reserved backup shape, not a data model: it only ever appears for a
 * key that is on RAW_LOCAL_STORAGE_PREFIXES, and import unwraps it before any
 * writer sees it.
 */
export const RAW_STRING_ENVELOPE = '__augustRawLocalStorageString';

const rawStringEnvelope = (value: string): Record<string, string> => ({ [RAW_STRING_ENVELOPE]: value });

const isRawStringEnvelope = (value: unknown): value is Record<string, string> =>
    typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>)[RAW_STRING_ENVELOPE] === 'string';

/** The value as its owner would read it, or null when neither store has it. */
/** The two session-drawing buckets live behind storeBackend (a JSON file per
 *  session on desktop, localStorage on web) — NOT raw localStorage — so their
 *  export must read the same path the app reads, and a pre-migration
 *  localStorage copy must never shadow the file's fresher bytes. */
const STOREBACKED_DRAWING_PREFIXES: readonly string[] = [
    'trade_session_drawings_v1_',
    'trade_session_model_v1_',
];

/** The tracker's dedicated store: FILE-backed on desktop, SQLite on native,
 *  and therefore invisible to both generic sweeps. The explicit loop below
 *  reads it through `readTrackingSnapshot`, the tracker's own backend. */
const TRACKED_STORE_PREFIXES: readonly string[] = [
    'tracked_positions_v1_',
    'tracked_diagnoses_v1_',
    'tracked_diagnosis_queue_v1_',
];

const readSweptValue = async (key: string): Promise<unknown> => {
    if (STOREBACKED_DRAWING_PREFIXES.some(prefix => key.startsWith(prefix))) {
        const res = await readStore(key);
        if (res.ok && res.value !== null) {
            try { return JSON.parse(res.value); } catch { /* corrupt store → fall through */ }
        }
        // Absent or unreadable file: fall through — the legacy localStorage
        // copy (kept by the store's migration) is better than nothing.
    }
    // Raw-localStorage owners (profile memory, learning rules, the agent
    // rosters, the calibration stats, the learning-loop stores) write
    // localStorage DIRECTLY and never touch Preferences — so on native a
    // Preferences copy of one of these keys is by definition OLDER: the
    // one-time migration (PreferencesService.migrateLocalStorageToPreferences
    // copies EVERY localStorage key once) or the restore mirror. Reading
    // Preferences first exported that frozen copy forever while the owner's
    // live bytes sat in localStorage — every backup after a restore (or after
    // the migration) shipped stale data. The owner's store wins; Preferences
    // is the fallback for a key whose only copy is the mirror/legacy one.
    //
    // This is the mirror image of the restore side, and it is gated by the SAME
    // list: a key missing from RAW_LOCAL_STORAGE_PREFIXES does not merely fail
    // to restore, it exports the wrong bytes.
    if (isRawLocalStorageKey(key)) {
        try {
            const raw = typeof localStorage === 'undefined'
                ? null
                : localStorage.getItem(key);
            if (raw !== null) {
                try {
                    return JSON.parse(raw);
                } catch {
                    // Plain bytes (a username, a session id, a flag). Carry the
                    // exact string instead of dropping the key or corrupting it.
                    return rawStringEnvelope(raw);
                }
            }
        } catch { /* fall through to the Preferences copy */ }
    }
    return getPreferenceObject(key);
};

/** Put a raw-localStorage owner's key back where that owner reads it. On web
 *  this writes the same key with the same bytes PreferencesService just wrote. */
const mirrorToLocalStorage = (key: string, value: unknown): void => {
    if (!isRawLocalStorageKey(key)) return;
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(key, isRawStringEnvelope(value)
            ? value[RAW_STRING_ENVELOPE]
            : JSON.stringify(value));
    } catch (e) {
        // Quota here is not a restore failure: the Preferences copy is written
        // and reported. Say so, rather than marking the key failed.
        console.warn(`[ExportService] Mirrored write to localStorage skipped for ${key}:`, e);
    }
};

const byteLength = (s: string): number =>
    (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length);

/** Put one swept value into the backup, applying the per-store cap. A capped
 *  store is LEFT OUT with a notice rather than truncated: a backup that silently
 *  lost the transcripts is worse than one that says it did. */
const putSweptValue = (
    backup: Record<string, unknown>,
    notices: string[],
    key: string,
    raw: unknown,
): void => {
    const value = redactPreferenceValue(key, raw);
    const cap = EXPORT_KEY_CAPS.find(c => key.startsWith(c.prefix));
    if (cap) {
        const bytes = byteLength(JSON.stringify(value));
        if (bytes > cap.bytes) {
            notices.push(`${key}: NOT IN THIS BACKUP — ${bytes} bytes is over the ${cap.bytes}-byte cap${key.startsWith('trade_chat_sessions_v1') ? ' even after images were stripped' : ''}`);
            return;
        }
    }
    backup[key] = value;
};

type ChatSessionLike = { id?: unknown; entries?: unknown };

const sessionIdOf = (s: unknown): string | null =>
    typeof (s as ChatSessionLike | null)?.id === 'string' ? (s as { id: string }).id : null;

/** Does this live session still hold image bytes the backup deliberately dropped? */
const hasImageBytes = (s: unknown): boolean => {
    const entries = (s as ChatSessionLike | null)?.entries;
    return Array.isArray(entries) && entries.some(e =>
        typeof (e as { image?: unknown } | null)?.image === 'string'
        && (e as { image: string }).image.length > 0);
};

/**
 * A backup's chat rows travel without image bytes, so restoring one onto an install
 * that still holds those screenshots would DELETE them — data loss caused by the
 * restore rather than by the backup. Reconcile by session id before anything is
 * written: a live session carrying images always keeps its own bytes, missing
 * sessions are added, and a live copy with no images accepts the backup's text.
 *
 * The result may exceed the owner's MAX_SESSIONS. That is deliberate: trimming here
 * would subtract rows that exist on the device, which is the failure this function
 * exists to prevent; `chatSessions` trims on its next write.
 */
const mergeChatSessionsWithLive = (key: string, backupValue: unknown): unknown => {
    if (!Array.isArray(backupValue)) return backupValue;
    let live: unknown;
    try {
        live = typeof localStorage === 'undefined' ? null : JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch { live = null; }
    if (!Array.isArray(live) || live.length === 0) return backupValue;

    const merged: unknown[] = [...live];
    for (const session of backupValue) {
        const id = sessionIdOf(session);
        const existing = id === null ? undefined : live.find(s => sessionIdOf(s) === id);
        if (existing && hasImageBytes(existing)) continue;
        const at = merged.findIndex(s => sessionIdOf(s) === id);
        if (at >= 0) merged[at] = session; else merged.push(session);
    }
    return merged;
};

/**
 * Export all preference keys as a supplementary backup
 * This captures settings that aren't in database
 */
export const exportPreferencesData = async (): Promise<Record<string, any>> => {
    const backup: Record<string, any> = {};
    const notices: string[] = [];

    // Get all values from PreferencesService (handles native/web abstraction)
    const keysToBackup = Object.values(PREF_KEYS);

    for (const key of keysToBackup) {
        try {
            const value = await readSweptValue(key);
            if (value !== null) {
                putSweptValue(backup, notices, key, value);
            }
        } catch (e) {
            console.warn(`[ExportService] Failed to export key ${key}:`, e);
        }
    }

    // Per-user scoped keys (memory_files_v1_<user>, memory_injections_v1_<user>,
    // learning_rules_v2_<user>, attributed_insights_kb_<user>,
    // global_learning_state_<user>, rl_signals_data) are NOT in PREF_KEYS.
    // Sweep BOTH sources: localStorage keys (web fallback) and the full
    // Preferences key list via getAllKeys() — on native, Capacitor Preferences
    // is NOT localStorage, so the notebook would silently vanish from backups
    // without the abstraction-level sweep.
    try {
        const swept = new Set<string>();
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) swept.add(key);
        }
        try {
            for (const key of await getAllKeys()) swept.add(key);
        } catch { /* abstraction listing unavailable — localStorage sweep still ran */ }
        for (const key of swept) {
            if (!key || keysToBackup.includes(key)) continue;
            const value = await readSweptValue(key);
            if (value !== null) {
                putSweptValue(backup, notices, key, value);
            }
        }
    } catch (e) {
        console.warn('[ExportService] Per-user key sweep failed:', e);
    }

    // The session stores are FILE-backed on desktop and keyed by user/session,
    // so neither sweep source (localStorage, Preferences keys) enumerates them —
    // a fresh desktop profile's chats and drawings would silently miss every
    // backup. Read the sessions store file-aware, export the chat list itself,
    // then export both drawing buckets per session. Keys the generic sweep
    // already found are re-put here with the file's fresher bytes — last write
    // wins, deliberately.
    try {
        const user = getActiveUsername();
        const chatKey = `trade_chat_sessions_v1_${user}`;
        const sessionsRes = await readStore(chatKey);
        const parsed = sessionsRes.ok && sessionsRes.value ? JSON.parse(sessionsRes.value) : null;
        const sessions = Array.isArray(parsed) ? parsed : [];
        if (Array.isArray(parsed)) putSweptValue(backup, notices, chatKey, parsed);
        for (const sid of sessions.map(sessionIdOf).filter((v): v is string => !!v)) {
            for (const prefix of STOREBACKED_DRAWING_PREFIXES) {
                const key = `${prefix}${user}_${sid}`;
                const value = await readSweptValue(key);
                if (value !== null) putSweptValue(backup, notices, key, value);
            }
        }
    } catch (e) {
        console.warn('[ExportService] Session-store sweep failed:', e);
    }

    // The tracker's dedicated store is not part of the profile blob. Read it
    // through its OWN backend: on native that is SQLite, which `readStore`
    // cannot see.
    try {
        const user = getActiveUsername();
        const { readTrackingSnapshot } = await import('../tracking/positionStore');
        const snapshot = await readTrackingSnapshot(user);
        if (!snapshot.ok) {
            console.warn('[ExportService] Tracker-store read failed:', snapshot.error);
        } else {
            for (const prefix of TRACKED_STORE_PREFIXES) {
                const kind = prefix.replace(/^tracked_/, '').replace(/_v1_$/, '') as keyof typeof snapshot.snapshot;
                const raw = snapshot.snapshot[kind];
                if (raw === null) continue;
                try {
                    putSweptValue(backup, notices, `${prefix}${user}`, JSON.parse(raw));
                } catch {
                    console.warn(`[ExportService] Tracker ${kind} is not JSON; left out of the backup.`);
                }
            }
        }
    } catch (e) {
        console.warn('[ExportService] Tracker-store sweep failed:', e);
    }

    // Only present when something was left out. Restores skip it as an
    // un-allow-listed key, which is what makes the omission visible on both ends
    // instead of a silent hole in the backup.
    if (notices.length) backup._backup_notices = notices;

    return backup;
};

/**
 * Preference keys a backup is allowed to restore.
 *
 * `exportPreferencesData` sweeps EVERY key in the Preferences/localStorage
 * store, so an unfiltered import lets a crafted backup plant arbitrary keys
 * (arbitrary pref-key injection). Restores are therefore gated by this
 * allow-list, which enumerates what the app itself writes at backup time:
 * the PREF_KEYS constants plus every username-scoped / service namespace
 * greppable in the codebase (memory files, learning rules, chat sessions,
 * drawings, desk state, forged tools, agent roster, …).
 * Unknown keys are skipped and reported, never silently persisted.
 */
const RESTORABLE_PREFERENCE_KEYS: ReadonlySet<string> = new Set<string>([
    ...(Object.values(PREF_KEYS) as string[]),
    // Exact static app-state keys written as JSON through
    // setPreferenceObject / localStorage (so the export sweep captures
    // them) but living outside PREF_KEYS:
    //   model_catalog_sweep_v1 (hooks/useModelCatalogRefresh)
    //   session_usage_v1       (utils/sessionUsage)
    //   trading_checklist_v1   (utils/checklist)
    //   memory_amendments_v1   (services/learning/memoryAmendments)
    //   august_harness_lessons_v1 (services/learning/harnessLessons)
    //   thinking_leak_bin_v1   (utils/thinkingLeakBin)
    // NOT added: 'august_surface_v1' and 'sidebar_pane_v1' — the same sweep
    // DROPS them because they are stored as PLAIN strings (raw
    // localStorage.setItem / setPreference, no JSON), so getPreferenceObject
    // can never parse them into a backup. Allowing them would open a restore
    // write-path for a value the readers (raw string compares) would ignore.
    'model_catalog_sweep_v1',
    'session_usage_v1',
    'trading_checklist_v1',
    'memory_amendments_v1',
    'august_harness_lessons_v1',
    'thinking_leak_bin_v1',
]);

/** Prefix-matched namespaces for dynamic/scoped keys. */
const RESTORABLE_PREFERENCE_KEY_PREFIXES: readonly string[] = [
    // Learning / memory (username-scoped)
    'memory_files_v1_',
    'memory_files_v2_',
    'memory_files_corrupt_v1_',
    'memory_injections_v1_',
    'learning_rules_v2_',
    'global_learning_state_',
    'rl_signals_data',
    'profile_memory_v1',
    'august_starred_models_v1',
    'monthly_report_v1_',
    'meta_calibration_v1_',
    'regime_ledger_v1_',
    'preflight_results_v1_',
    // Historical lifecycle keys remain restorable but have no active consumers.
    'skill_graveyard_v1_',
    'strategy_regime_matrix_v1_',
    'weekly_review_v1_',
    'weekly_rollup_v1_',
    'pass_mining_v1_',
    'skill_veto_ledger_v1_',
    'belief_challenge_v1_',
    'learning_proposals_v1',
    'skill_drafts_v1',
    'session_review_counter_v1',
    'session_review_drafted_v1',
    'session_review_open_theses_v1',
    'session_review_resolver_v1',
    'trader_learning_v1',
    'trader_learner_counter_v1',
    'supervisor_auto_v1',
    'supervisor_last_run_v1',
    'learning_judge_gate_v1_',
    'learning_measure_v1_',
    // The signal ledger — emitted calls and their resolutions. Scoped
    // `signal_ledger_v1:<user>`; without this prefix a restore would return the
    // journal but drop the calls the desk was graded on.
    'signal_ledger_v1',
    // The tracked-position store — open plans, their paths and their
    // post-mortems. Scoped `tracked_<kind>_v1_<user>`.
    'tracked_positions_v1_',
    'tracked_diagnoses_v1_',
    'tracked_diagnosis_queue_v1_',
    // Per-user prompt and strategy docs (both live), plus the automation
    // namespaces: that feature was deleted on 2026-10-24, but a backup taken
    // before it still names those keys, and a restore must ignore them rather
    // than fail.
    'prompt_overrides_v1_',
    'strategy_docs_v1_',
    'automations_v1_',
    'automation_runs_v1_',
    'automation_last_seen_v1_',
    // Trading surface (watches, levels, chat sessions, drawings)
    'trade_level_hits_v1',
    'trade_level_arms_v1',
    'trade_watches_v1',
    'trade_declines_v1',
    'trade_chat_sessions_v1_',
    'trade_chat_active_v1_',
    'trade_drawings_v1_',
    'trade_session_drawings_v1_',
    'trade_session_model_v1_',
    'trade_sidebar_open_v1',
    'trade_tf_bar_v1',
    // Bots / agents / desk
    'agents_bots_v1',
    'agents_groups_v1',
    'agent_threads_opened_v1',
    'desk_tools_forged_v1',
    'desk_idle_motion_v1',
    // Exported by the sweep above, so they must be accepted back: a key the
    // backup carries and the restore refuses is a half-migration, and this block
    // was missing six of them until `scripts/check-contracts.cjs` started
    // asserting the pair. The layout keys are the trader's dragged widths.
    'model_confidence_calibration',
    'approval_rules_v1',
    'trade_tool_payloads_v1',
    'nav_rail_width_v1',
    'nav_rail_expanded_px_v1',
    'right_panel_width_v1',
    // Shell / misc app state
    'harness_settings_v1',
    'book_drafts_seeded_v1',
    'august_active_user',
    'last_active_user',
    'august_sidebar_pane',
    // Per-user variants of PREF_KEYS values (`<key>_<username>`)
    'data_version_',
    'last_session_',
    'last_trade_count_',
];

export const isRestorablePreferenceKey = (key: string): boolean =>
    RESTORABLE_PREFERENCE_KEYS.has(key) ||
    RESTORABLE_PREFERENCE_KEY_PREFIXES.some(prefix => key.startsWith(prefix));

/** Outcome of an importPreferencesData run (returned + logged; callers may ignore). */
export interface ImportPreferencesReport {
    /** Allowed keys successfully persisted. */
    keysWritten: number;
    /** Keys present in the backup that are NOT on the restore allow-list. */
    skippedKeys: string[];
    /** Allowed keys whose write threw (restore was partial). */
    failedKeys: string[];
    /** Provider entries accepted into provider_configs_v1. */
    providersImported: number;
    /** Provider entries dropped for an unparseable/invalid baseUrl or shape. */
    providersDropped: number;
    /** Entries that inherited the live key (backup pointed at the same endpoint). */
    providersKeyGrafted: number;
    /** Entries kept but with an EMPTY key — the user must re-enter it. */
    providersRequiringKeyReentry: number;
}

/**
 * Merge a backup's provider list into the live one WITHOUT ever letting the
 * merge exfiltrate a live API key. Exported backups redact keys, so a naive
 * "keep the current key when the backup's is empty" graft lets a crafted
 * backup pair `{apiKey:'', baseUrl:'https://evil.tld'}` with the user's REAL
 * key (key grafting onto an attacker-chosen host). Rules:
 *  - every imported baseUrl must pass validateProviderUrl or the entry is
 *    dropped (counted);
 *  - the live key is grafted ONLY when the backup entry points at exactly the
 *    same validated endpoint as the current config for that id;
 *  - a changed or absent baseUrl with an empty backup key yields a
 *    present-but-not-ready entry (empty key) so the UI asks the user to
 *    re-enter it instead of silently sending their key somewhere new;
 *  - symmetrically, a BACKUP-carried key is kept only when the id is new
 *    (fresh-machine restore) or the live config for that id points at the
 *    SAME validated endpoint. A crafted entry that re-uses an existing id
 *    but swaps baseUrl to an attacker host (e.g.
 *    `{id:'openai', apiKey:'...', baseUrl:'https://evil'}`) would otherwise
 *    wholesale replace the live config and route the user's prompts there —
 *    so on a changed (or unparseable) live baseUrl the backup key is
 *    CLEARED unconditionally: present-but-not-ready, user re-enters.
 */
const mergeProviderConfigsForImport = async (
    backupProviders: unknown[],
    existing: ProviderConfig[],
): Promise<{ merged: ProviderConfig[]; dropped: number; grafted: number; reentry: number }> => {
    const merged: ProviderConfig[] = [];
    let dropped = 0;
    let grafted = 0;
    let reentry = 0;

    // Normalize an endpoint for same-host comparison: validated → normalized
    // URL, absent/empty → '', present-but-invalid → null (never equal).
    const normalizeEndpoint = (baseUrl: string): string | null => {
        if (!baseUrl) return '';
        const validation = validateProviderUrl(baseUrl);
        return validation.valid ? validation.normalizedUrl : null;
    };

    for (const raw of backupProviders) {
        if (!raw || typeof raw !== 'object' || typeof (raw as { id?: unknown }).id !== 'string') {
            dropped += 1;
            continue;
        }
        const provider = raw as ProviderConfig;
        const rawBaseUrl = typeof provider.baseUrl === 'string' ? provider.baseUrl.trim() : '';

        let normalizedBackupUrl: string | null = null;
        if (rawBaseUrl) {
            const validation = validateProviderUrl(rawBaseUrl);
            if (!validation.valid) {
                console.warn(`[ExportService] Dropped imported provider "${provider.id}": invalid baseUrl (${validation.message})`);
                dropped += 1;
                continue;
            }
            normalizedBackupUrl = validation.normalizedUrl;
        }

        const current = existing.find(item => item?.id === provider.id);
        const currentBaseUrl = typeof current?.baseUrl === 'string' ? current.baseUrl.trim() : '';

        const backupKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
        if (backupKey) {
            // The backup carries its own key (non-redacted / hand-made file).
            // Keep it only when nothing is being re-pointed: either the id is
            // new (fresh-machine restore — no live config to hijack) or the
            // live config for this id already normalizes to the SAME
            // endpoint. Otherwise the entry re-targets an existing provider
            // at a different host and its key is cleared (see doc above).
            const currentNormalized = normalizeEndpoint(currentBaseUrl);
            const backupNormalized = normalizeEndpoint(rawBaseUrl);
            const endpointChanged = Boolean(current) && currentNormalized !== backupNormalized;
            if (endpointChanged) {
                console.warn(`[ExportService] Cleared backup key for "${provider.id}": backup baseUrl differs from the live config's (restore will ask for the key)`);
                merged.push({ ...provider, baseUrl: normalizedBackupUrl ?? provider.baseUrl, apiKey: '' });
                reentry += 1;
            } else {
                merged.push({ ...provider, baseUrl: normalizedBackupUrl ?? provider.baseUrl });
            }
            continue;
        }

        // Empty backup key (the normal redacted case). Graft the live key only
        // when both sides validate to the SAME endpoint.
        const currentKey = typeof current?.apiKey === 'string' ? current.apiKey : '';
        const currentNormalized = normalizeEndpoint(currentBaseUrl);
        if (
            currentKey &&
            normalizedBackupUrl &&
            currentNormalized &&
            currentNormalized === normalizedBackupUrl
        ) {
            merged.push({ ...provider, baseUrl: normalizedBackupUrl, apiKey: currentKey });
            grafted += 1;
        } else {
            if (currentKey) reentry += 1; // would have been grafted pre-fix
            merged.push({ ...provider, apiKey: '' });
        }
    }

    return { merged, dropped, grafted, reentry };
};

/**
 * Import preference keys from backup.
 *
 * SECURITY: only allow-listed keys are persisted (see
 * {@link isRestorablePreferenceKey}); provider entries go through the
 * hardened key-graft rules (see {@link mergeProviderConfigsForImport}).
 * The returned report counts drops/skips so restore callers can surface
 * a partial restore instead of it being silent.
 */
export const importPreferencesData = async (
    backup: Record<string, any>,
): Promise<ImportPreferencesReport> => {
    const report: ImportPreferencesReport = {
        keysWritten: 0,
        skippedKeys: [],
        failedKeys: [],
        providersImported: 0,
        providersDropped: 0,
        providersKeyGrafted: 0,
        providersRequiringKeyReentry: 0,
    };

    for (const [key, value] of Object.entries(backup)) {
        try {
            if (!isRestorablePreferenceKey(key)) {
                console.warn(`[ExportService] Skipped non-allow-listed backup key: ${key}`);
                report.skippedKeys.push(key);
                continue;
            }
            if (key === PREF_KEYS.PROVIDER_CONFIGS && Array.isArray(value)) {
                const existing = await getPreferenceObject<ProviderConfig[]>(key) || [];
                const { merged, dropped, grafted, reentry } = await mergeProviderConfigsForImport(value, existing);
                // Through ProviderConfigService, NOT a raw setPreferenceObject:
                // API keys are encrypted at rest on desktop (Electron safeStorage
                // → OS keychain), and only that service knows the `enc:v1:`
                // convention. Writing the merged list directly left a restored
                // backup key in PLAINTEXT in Preferences until some later CRUD
                // save happened to re-encrypt it — a window in which the live
                // key sat unencrypted on disk.
                //
                // The hardening above is unaffected: `existing` is read raw
                // (ciphertext), a grafted key therefore IS the live ciphertext,
                // and saveProviderConfigs' encryptKey passes an already-prefixed
                // value through untouched; a plaintext key it receives is
                // encrypted normally. The endpoint-mismatch rules that decide
                // WHETHER a key survives are unchanged.
                await saveProviderConfigs(merged);
                report.keysWritten += 1;
                report.providersImported = merged.length;
                report.providersDropped = dropped;
                report.providersKeyGrafted = grafted;
                report.providersRequiringKeyReentry = reentry;
                continue;
            }
            // Known preference key — persist exactly as before.
            // A stripped backup must not overwrite images the device still has.
            // Reconciled ONCE and written to BOTH stores, so neither holds a copy
            // the other does not.
            const writeValue = key.startsWith('trade_chat_sessions_v1')
                ? mergeChatSessionsWithLive(key, value)
                : value;
            if (isRawStringEnvelope(writeValue)) {
                // The owner reads the raw bytes. Write those, not the JSON
                // spelling of a string, to Preferences and to localStorage.
                await setPreference(key, writeValue[RAW_STRING_ENVELOPE]);
                mirrorToLocalStorage(key, writeValue);
                report.keysWritten += 1;
                continue;
            }
            if (typeof writeValue === 'object') {
                await setPreferenceObject(key, writeValue);
            } else {
                // If it's a string, we might need setPreference, but setPreferenceObject handles objects
                // wrapper might be needed if base is string
                await setPreferenceObject(key, writeValue);
            }
            // …and where the owner actually reads. See RAW_LOCAL_STORAGE_PREFIXES.
            mirrorToLocalStorage(key, writeValue);
            report.keysWritten += 1;
        } catch (error) {
            console.error(`[ExportService] Failed to import key ${key}:`, error);
            report.failedKeys.push(key);
        }
    }

    // A restore of the file-backed session stores replaced bytes under the
    // running caches. Re-prime the chat store and drop the drawings mirror so
    // the next read is the restored file, not the pre-import copy.
    const restoredSessionStores = Object.keys(backup).some(k =>
        k.startsWith('trade_chat_sessions_v1')
        || k.startsWith('trade_session_drawings_v1_')
        || k.startsWith('trade_session_model_v1_'));
    if (restoredSessionStores && report.keysWritten > 0) {
        try {
            const [{ primeChatSessions }, chatStore, { resetDrawingsCache }] = await Promise.all([
                import('../trade/chatSessions'),
                import('../trade/chatStore'),
                import('../trade/chartDrawings'),
            ]);
            await primeChatSessions(getActiveUsername());
            chatStore.resetForUserSwitch();
            resetDrawingsCache();
        } catch (e) {
            console.warn('[ExportService] Post-restore session cache refresh failed:', e);
        }
    }

    if (report.skippedKeys.length || report.failedKeys.length || report.providersDropped || report.providersRequiringKeyReentry) {
        console.warn('[ExportService] importPreferencesData report:', report);
    }
    return report;
};
