/**
 * NewBotDialog — the "New Bot" dialog: big avatar
 * preview, face picker (Auto + the 10 built-in faces, our pixel
 * avatars on a second tab), Randomize with a "face follows the name"
 * hint, Name / Title / Description fields, and the provider+model
 * this bot thinks with. Create adds the bot to the roster.
 */

import React from 'react';
import { X } from '../shared/Icons';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { BotFace, BUILTIN_FACES, UPLOADABLE_FACES, randomFace, type BotFaceSpec, type FaceShape } from './BotFace';
import { PixelAvatarFigure } from './BotAvatar';
import type { AgentBot } from '../../services/agents/agentRoster';
import { ProviderConfig } from '../../types/provider';
import { findProviderById, formatModelDisplayName, isProviderReady } from '../../utils/providerUtils';
import { ROLE_ACCENTS } from './pixelAvatars';
import { SelectMenu } from '../shared/SelectMenu';
import { useEscapeClose } from '../../hooks/useEscapeClose';

export interface NewBotDialogProps {
    open: boolean;
    onClose: () => void;
    onCreate: (bot: Omit<AgentBot, 'id' | 'createdAt'>) => void;
    providers: ProviderConfig[];
}

const PIXEL_ROLE_CHOICES = (Object.keys(ROLE_ACCENTS) as Array<keyof typeof ROLE_ACCENTS>)
    .filter(r => r !== 'unknown' && r !== 'postmortem');

/** Default the dialog to the first ready provider (enabled + keyed). */
const firstReadyProviderId = (providers: ProviderConfig[]): string =>
    providers.find(isProviderReady)?.id ?? providers[0]?.id ?? '';

export const NewBotDialog: React.FC<NewBotDialogProps> = ({ open, onClose, onCreate, providers }) => {
    const [name, setName] = React.useState('');
    const [title, setTitle] = React.useState('');
    const [description, setDescription] = React.useState('');
    const [tab, setTab] = React.useState<'faces' | 'upload' | 'pixel'>('faces');
    const [face, setFace] = React.useState<BotFaceSpec | 'auto'>('auto');
    const [uploadSrc, setUploadSrc] = React.useState<string | null>(null);
    const [uploadShape, setUploadShape] = React.useState<FaceShape>('circle');
    const [pixelRole, setPixelRole] = React.useState<(typeof PIXEL_ROLE_CHOICES)[number]>('macro');
    const [customPrompt, setCustomPrompt] = React.useState('');
    const [providerId, setProviderId] = React.useState<string>(() => firstReadyProviderId(providers));
    const [modelId, setModelId] = React.useState<string>('');
    const [advancedOpen, setAdvancedOpen] = React.useState(false);
    // WS-3.1: whether this bot thinks with the shared notebook at all.
    const [isolated, setIsolated] = React.useState(false);
    useEscapeClose(open, onClose);

    const provider = findProviderById(providers, providerId) ?? providers[0];
    // Fall back to the provider's selected model (then its first) until
    // the trader picks one explicitly.
    const effectiveModel = modelId && provider?.models.includes(modelId)
        ? modelId
        : provider?.selectedModel || provider?.models[0] || '';

    React.useEffect(() => {
        if (open) {
            setName(''); setTitle(''); setDescription('');
            setFace('auto'); setTab('faces');
            setUploadSrc(null); setUploadShape('circle');
            setCustomPrompt('');
            setProviderId(firstReadyProviderId(providers));
            setModelId('');
        }
    }, [open]);

    // Created from a rail button while the roster stays reachable behind it;
    // without a trap Tab leaves the open form and the focus goes with it (O-66).
    const dialogRef = useFocusTrap<HTMLDivElement>(open);
    if (!open) return null;

    const readyProviders = providers.filter(isProviderReady);
    const canCreate = name.trim().length > 0 && provider && effectiveModel.length > 0;

    const create = (): void => {
        if (!canCreate || !provider) return;
        onCreate({
            name: name.trim(),
            title: title.trim() || undefined,
            description: description.trim() || undefined,
            providerId: provider.id,
            modelId: effectiveModel,
            memoryScope: isolated ? 'isolated' : 'global',
            customPrompt: customPrompt.trim() || undefined,
            avatar: tab === 'pixel'
                ? { kind: 'pixel', role: pixelRole }
                : tab === 'upload' && uploadSrc
                    ? { kind: 'upload', src: uploadSrc, shape: uploadShape }
                    : face === 'auto' ? { kind: 'auto' } : { kind: 'face', spec: face },
        });
        onClose();
    };

    const previewName = name.trim() || 'New Bot';

    return (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 p-4" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="New Bot">
            <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-bubble border border-hairline bg-zinc-950 p-6 shadow-elevated" data-testid="new-bot-dialog">
                <div className="flex items-start justify-between">
                    <div>
                        <h2 className="text-lg font-semibold text-zinc-100">New Bot</h2>
                        <p className="mt-1 text-ui-sm leading-snug text-zinc-500">
                            A named teammate with its own memory, skills, and chat. It can message your other agents.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close new bot dialog"
                        className="rounded-control p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>

                {/* Avatar preview */}
                <div className="mt-5 flex justify-center">
                    {tab === 'pixel'
                        ? <PixelAvatarFigure role={pixelRole} size={72} />
                        : tab === 'upload'
                            ? <BotFace face={{ shape: uploadShape, hue: '#000000' }} name={previewName} size={72} uploadSrc={uploadSrc ?? undefined} />
                            : <BotFace face={face} name={previewName} size={72} />}
                </div>

                {/* Avatar tabs */}
                <div className="mt-4 flex justify-center gap-1">
                    {([['faces', 'Faces'], ['upload', 'Upload'], ['pixel', 'Pixel']] as const).map(([key, label]) => (
                        <button
                            key={key}
                            type="button"
                            onClick={() => setTab(key)}
                            data-testid={`avatar-tab-${key}`}
                            className={`rounded-control px-3 py-1.5 text-ui-sm font-semibold transition-colors ${
                                tab === key ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {/* Face grid — Auto + the 10 built-ins */}
                {tab === 'faces' ? (
                    <div className="mt-4">
                        <div className="grid grid-cols-6 justify-items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setFace('auto')}
                                data-testid="face-auto"
                                aria-label="Auto face (follows the name)"
                                className={`flex h-11 w-11 items-center justify-center rounded-control border text-ui-xs font-semibold uppercase tracking-wide ${
                                    face === 'auto' ? 'border-zinc-400 bg-zinc-800 text-zinc-200' : 'border-hairline text-zinc-500 hover:border-line'
                                }`}
                            >
                                Auto
                            </button>
                            {BUILTIN_FACES.map((spec, i) => (
                                <button
                                    key={`${spec.shape}-${spec.hue}`}
                                    type="button"
                                    onClick={() => setFace(spec)}
                                    data-testid={`face-${i}`}
                                    aria-label={`Face ${i + 1}`}
                                    className={`flex h-11 w-11 items-center justify-center rounded-control border ${
                                        face !== 'auto' && face.shape === spec.shape && face.hue === spec.hue
                                            ? 'border-zinc-400 bg-zinc-800'
                                            : 'border-transparent hover:border-line'
                                    }`}
                                >
                                    <BotFace face={spec} name={previewName} size={34} />
                                </button>
                            ))}
                        </div>
                        <div className="mt-3 flex items-center justify-center gap-4">
                            <button
                                type="button"
                                onClick={() => setFace(randomFace())}
                                className="flex items-center gap-1.5 text-ui-sm font-medium text-zinc-300 hover:text-zinc-100"
                            >
                                ⟳ Randomize
                            </button>
                        </div>
                        <p className="mt-1 text-center text-ui-dense text-zinc-600">
                            {face === 'auto' ? 'Face follows the name.' : 'Pinned face.'}
                        </p>
                    </div>
                ) : tab === 'upload' ? (
                    <div className="mt-4">
                        <div className="grid grid-cols-3 justify-items-center gap-2">
                            {UPLOADABLE_FACES.map(spec => (
                                <button
                                    key={spec.shape}
                                    type="button"
                                    onClick={() => setUploadShape(spec.shape)}
                                    data-testid={`upload-shape-${spec.shape}`}
                                    aria-label={`${spec.shape} clip`}
                                    className={`flex h-11 w-11 items-center justify-center rounded-control border ${
                                        uploadShape === spec.shape ? 'border-zinc-400 bg-zinc-800' : 'border-transparent hover:border-line'
                                    }`}
                                >
                                    <BotFace face={spec} name={previewName} size={34} uploadSrc={uploadSrc ?? undefined} />
                                </button>
                            ))}
                        </div>
                        <div className="mt-3 flex items-center justify-center">
                            <label className="cursor-pointer rounded-control border border-hairline bg-zinc-900 px-3 py-1.5 text-ui-sm font-medium text-zinc-300 hover:border-line hover:text-zinc-100">
                                {uploadSrc ? 'Replace image…' : 'Upload image…'}
                                <input
                                    type="file"
                                    accept="image/*"
                                    data-testid="upload-input"
                                    className="hidden"
                                    onChange={e => {
                                        const file = e.target.files?.[0];
                                        if (!file) return;
                                        const reader = new FileReader();
                                        reader.onload = (): void => {
                                            const dataUrl = typeof reader.result === 'string' ? reader.result : '';
                                            // Downscale to 96px cover-cropped before storing —
                                            // the avatar persists to localStorage and raw phone
                                            // photos would blow the quota instantly.
                                            const img = new Image();
                                            img.onload = (): void => {
                                                const S = 96;
                                                const canvas = document.createElement('canvas');
                                                canvas.width = S;
                                                canvas.height = S;
                                                const ctx = canvas.getContext('2d');
                                                if (!ctx) { setUploadSrc(dataUrl); return; }
                                                const scale = Math.max(S / img.width, S / img.height);
                                                const w = img.width * scale;
                                                const h = img.height * scale;
                                                ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
                                                setUploadSrc(canvas.toDataURL('image/png'));
                                            };
                                            img.onerror = (): void => setUploadSrc(dataUrl);
                                            img.src = dataUrl;
                                        };
                                        reader.readAsDataURL(file);
                                    }}
                                />
                            </label>
                        </div>
                        <p className="mt-1 text-center text-ui-dense text-zinc-600">
                            {uploadSrc ? 'Stored locally, downscaled to 96px.' : 'Pick an image — it stays on this device.'}
                        </p>
                    </div>
                ) : (
                    <div className="mt-4">
                        <div className="grid grid-cols-7 justify-items-center gap-2">
                            {PIXEL_ROLE_CHOICES.map(role => (
                                <button
                                    key={role}
                                    type="button"
                                    onClick={() => setPixelRole(role)}
                                    data-testid={`pixel-${role}`}
                                    aria-label={`Pixel ${role}`}
                                    className={`flex h-11 w-11 items-center justify-center rounded-control border ${
                                        pixelRole === role ? 'border-zinc-400 bg-zinc-800' : 'border-transparent hover:border-line'
                                    }`}
                                >
                                    <PixelAvatarFigure role={role} size={34} />
                                </button>
                            ))}
                        </div>
                        <p className="mt-3 text-center text-ui-dense text-zinc-600">Our pixel seats, role-colored.</p>
                    </div>
                )}

                {/* Fields */}
                <div className="mt-5 space-y-3">
                    <div>
                        <label htmlFor="bot-name" className="mb-1 block text-ui-sm font-semibold text-zinc-300">Name</label>
                        <input
                            id="bot-name"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="inbox-triage"
                            data-testid="bot-name"
                            className="w-full rounded-control border border-hairline bg-zinc-900 px-3 py-2 text-ui-caption text-zinc-100 placeholder-zinc-600 outline-none focus:border-line"
                        />
                    </div>
                    <div>
                        <label htmlFor="bot-title" className="mb-1 block text-ui-sm font-semibold text-zinc-300">Title</label>
                        <input
                            id="bot-title"
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            placeholder="Inbox Triage"
                            className="w-full rounded-control border border-hairline bg-zinc-900 px-3 py-2 text-ui-caption text-zinc-100 placeholder-zinc-600 outline-none focus:border-line"
                        />
                    </div>
                    <div>
                        <label htmlFor="bot-desc" className="mb-1 block text-ui-sm font-semibold text-zinc-300">Description</label>
                        <textarea
                            id="bot-desc"
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            placeholder="What should this Bot help with?"
                            rows={3}
                            className="w-full resize-none rounded-control border border-hairline bg-zinc-900 px-3 py-2 text-ui-caption text-zinc-100 placeholder-zinc-600 outline-none focus:border-line"
                        />
                    </div>

                    {/* Trader instructions — the bot's whole persona now: the
                        built-in analyst roles are gone, so what is written here
                        IS the mandate. Empty = the general-analyst default. */}
                    <div className="space-y-3 rounded-control border border-hairline bg-zinc-900/50 p-3">
                        <div>
                            <span className="mb-1 block text-ui-dense font-semibold uppercase tracking-widest text-zinc-500">Trader instructions</span>
                            <textarea
                                value={customPrompt}
                                onChange={e => setCustomPrompt(e.target.value)}
                                placeholder="Leave empty for the general-analyst default (full market analysis, web + tools)"
                                rows={3}
                                data-testid="bot-instructions"
                                className="w-full resize-y rounded-control border border-hairline bg-zinc-900 px-3 py-2 text-ui-sm leading-relaxed text-zinc-100 placeholder-zinc-600 outline-none focus:border-line"
                            />
                            <p className="mt-1 text-ui-dense leading-snug text-zinc-600">
                                Used as the bot persona wherever it answers. Empty means the general-analyst default.
                            </p>
                        </div>
                    </div>

                    {/* Advanced — provider + model this bot thinks with */}
                    <button
                        type="button"
                        onClick={() => setAdvancedOpen(v => !v)}
                        aria-expanded={advancedOpen}
                        className="flex items-center gap-1.5 text-ui-sm font-semibold text-zinc-400 hover:text-zinc-200"
                    >
                        {advancedOpen ? '▾' : '▸'} Advanced
                    </button>
                    {advancedOpen && (
                        <div className="space-y-3 rounded-control border border-hairline bg-zinc-900/50 p-3">
                            <div>
                                <span className="mb-1 block text-ui-dense font-semibold uppercase tracking-widest text-zinc-500">Shared notebook</span>
                                <label className="flex items-start gap-2 text-ui-sm text-zinc-300">
                                    <input type="checkbox" checked={isolated} data-testid="bot-memory-isolated"
                                        onChange={e => setIsolated(e.target.checked)}
                                        className="mt-0.5 h-3.5 w-3.5 accent-cyan-400" />
                                    <span>Isolate this bot from the shared book
                                        <span className="block text-ui-dense text-zinc-500">
                                            By default a bot reads the notebook the analysts read, and what it
                                            learns can surface for others. An isolated bot thinks from its own
                                            notes only.
                                        </span>
                                    </span>
                                </label>
                            </div>
                            <div>
                                <span className="mb-1 block text-ui-dense font-semibold uppercase tracking-widest text-zinc-500">Provider</span>
                                <SelectMenu
                                    aria-label="Provider"
                                    data-testid="bot-provider"
                                    value={providerId}
                                    onChange={setProviderId}
                                    options={readyProviders.map(p => ({ value: p.id, label: p.name }))}
                                    triggerClassName="w-full rounded-control border border-hairline bg-zinc-900 px-3 py-2 text-ui-caption hover:bg-zinc-800"
                                />
                            </div>
                            <div>
                                <span className="mb-1 block text-ui-dense font-semibold uppercase tracking-widest text-zinc-500">Model</span>
                                <SelectMenu
                                    aria-label="Model"
                                    data-testid="bot-model"
                                    value={effectiveModel}
                                    onChange={setModelId}
                                    options={(provider?.models ?? []).map(m => ({ value: m, label: formatModelDisplayName(m) }))}
                                    triggerClassName="w-full rounded-control border border-hairline bg-zinc-900 px-3 py-2 text-ui-caption hover:bg-zinc-800"
                                />
                            </div>
                            <p className="text-ui-dense leading-snug text-zinc-600">
                                The bot thinks with this model. Give two bots different models to keep their chats separate.
                            </p>
                        </div>
                    )}
                </div>

                <div className="mt-6 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-control px-4 py-2 text-ui-caption font-semibold text-zinc-400 hover:text-zinc-200"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={create}
                        disabled={!canCreate}
                        data-testid="create-bot"
                        className="rounded-control bg-zinc-200 px-4 py-2 text-ui-caption font-bold text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        Create Bot
                    </button>
                </div>
            </div>
        </div>
    );
};

export default NewBotDialog;
