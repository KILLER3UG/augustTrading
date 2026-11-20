/**
 * chartSnapshotAnnotator — offscreen bounded chart screenshot compositor that
 * paints crisp `#D1` / `#D2` drawing ID badges onto the chart capture so visual
 * snapshots match structured JSON `shortId`s 1:1.
 *
 * Defaults to `image/jpeg` (quality 0.85) capped at `1280×720` for universal
 * cloud & local-VLM compatibility while keeping vision token budgets bounded.
 */

export const MAX_SNAPSHOT_WIDTH = 1280;
export const MAX_SNAPSHOT_HEIGHT = 720;
export const DEFAULT_SNAPSHOT_MIME = 'image/jpeg' as const;
export const DEFAULT_SNAPSHOT_QUALITY = 0.85;

export interface SnapshotBadge {
    shortId: string;
    origin: 'user' | 'agent';
    /** X coordinate in CSS pixels relative to the overlay canvas. */
    x: number;
    /** Y coordinate in CSS pixels relative to the overlay canvas. */
    y: number;
    color?: string;
}

export interface AnnotatedSnapshotOptions {
    baseCanvas: HTMLCanvasElement;
    overlayCanvas?: HTMLCanvasElement | null;
    /** Overlay logical CSS dimensions (defaults to baseCanvas width/height). */
    overlayCssWidth?: number;
    overlayCssHeight?: number;
    backgroundColor?: string;
    badges?: ReadonlyArray<SnapshotBadge>;
    maxWidth?: number;
    maxHeight?: number;
    mimeType?: 'image/jpeg' | 'image/png' | 'image/webp';
    quality?: number;
}

/** Pure dimension scaler: fits `(width, height)` inside `(maxWidth, maxHeight)`
 *  preserving aspect ratio and never upscaling. */
export const computeSnapshotDimensions = (
    width: number,
    height: number,
    maxWidth = MAX_SNAPSHOT_WIDTH,
    maxHeight = MAX_SNAPSHOT_HEIGHT,
): { width: number; height: number; scale: number } => {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return {
        width: Math.max(1, Math.round(w * scale)),
        height: Math.max(1, Math.round(h * scale)),
        scale,
    };
};

/** Composite base chart + drawing overlay + `#D1..#Dn` badges onto an offscreen
 *  canvas bounded to `<= 1280×720` and export as JPEG (default) data URL. */
export const renderAnnotatedChartSnapshot = (opts: AnnotatedSnapshotOptions): string | null => {
    try {
        if (typeof document === 'undefined' || !opts.baseCanvas) return null;
        const srcW = opts.baseCanvas.width;
        const srcH = opts.baseCanvas.height;
        if (!(srcW > 0) || !(srcH > 0)) return null;

        const { width, height } = computeSnapshotDimensions(
            srcW,
            srcH,
            opts.maxWidth ?? MAX_SNAPSHOT_WIDTH,
            opts.maxHeight ?? MAX_SNAPSHOT_HEIGHT,
        );
        const out = document.createElement('canvas');
        out.width = width;
        out.height = height;
        const ctx = out.getContext('2d');
        if (!ctx) return null;

        ctx.fillStyle = opts.backgroundColor ?? '#0a0a0b';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(opts.baseCanvas, 0, 0, width, height);

        if (opts.overlayCanvas && opts.overlayCanvas.width > 0 && opts.overlayCanvas.height > 0) {
            ctx.drawImage(opts.overlayCanvas, 0, 0, width, height);
        }

        const badges = opts.badges ?? [];
        if (badges.length > 0) {
            const cssW = opts.overlayCssWidth && opts.overlayCssWidth > 0 ? opts.overlayCssWidth : srcW;
            const cssH = opts.overlayCssHeight && opts.overlayCssHeight > 0 ? opts.overlayCssHeight : srcH;
            const sx = width / cssW;
            const sy = height / cssH;

            ctx.save();
            ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.textBaseline = 'middle';
            for (const badge of badges) {
                if (!badge.shortId || !Number.isFinite(badge.x) || !Number.isFinite(badge.y)) continue;
                const text = badge.origin === 'agent' ? `AI ${badge.shortId}` : badge.shortId;
                const padX = 5;
                const boxH = 16;
                const boxW = Math.ceil(ctx.measureText(text).width) + padX * 2;
                const rawX = Math.round(badge.x * sx) + 4;
                const rawY = Math.round(badge.y * sy) - boxH - 3;
                const bx = Math.max(4, Math.min(width - boxW - 4, rawX));
                const by = Math.max(4, Math.min(height - boxH - 4, rawY));

                ctx.fillStyle = badge.origin === 'agent' ? 'rgba(24,24,27,0.88)' : 'rgba(9,9,11,0.92)';
                ctx.fillRect(bx, by, boxW, boxH);
                ctx.strokeStyle = badge.origin === 'agent' ? 'rgba(161,161,170,0.65)' : (badge.color || '#f4f4f5');
                ctx.lineWidth = 1;
                if (badge.origin === 'agent') ctx.setLineDash([3, 2]);
                ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
                ctx.setLineDash([]);

                ctx.fillStyle = badge.origin === 'agent' ? '#d4d4d8' : '#fafafa';
                ctx.fillText(text, bx + padX, by + boxH / 2 + 0.5);
            }
            ctx.restore();
        }

        const mime = opts.mimeType ?? DEFAULT_SNAPSHOT_MIME;
        const quality = opts.quality ?? DEFAULT_SNAPSHOT_QUALITY;
        return mime === 'image/png' ? out.toDataURL(mime) : out.toDataURL(mime, quality);
    } catch {
        return null;
    }
};
