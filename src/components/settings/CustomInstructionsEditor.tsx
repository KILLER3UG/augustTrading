/**
 * CustomInstructionsEditor - CRUD UI for custom instruction sets.
 *
 * Extracted from SettingsMenu.tsx (Custom Instructions view).
 * Manages the Standard / Strict Mode / Pure AI instruction tabs,
 * the token-usage meter and the expandable instruction cards.
 *
 * Note: the active tab state is owned by the parent (SettingsMenu) so the
 * selected tab persists while navigating between settings views.
 */

import React, { useState, useMemo } from 'react';
import { CustomInstructionsMap, CustomInstruction } from '../../types';
import { ChevronDownIcon, TrashIcon } from '../shared/Icons';
import { ToggleSwitch } from '../shared/ToggleSwitch';
import { useConfirmDialog } from '../shared/ConfirmDialog';
import StatusPill from '../ui/StatusPill';
import { SettingsPageHeader } from './tabs/shared';

// The one instruction list the harness reads (Settings -> Instructions).
export type InstructionTab = 'general';

const MAX_WORD_COUNT = 3000;
const MAX_ITEMS = 5;

// Expandable instruction card with inline editing, delete and activate toggle
const InstructionCard: React.FC<{
    instruction: CustomInstruction;
    onUpdate: (id: string, updates: Partial<CustomInstruction>) => void;
    onDelete: (id: string) => void;
}> = ({ instruction, onUpdate, onDelete }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const { confirm: confirmDelete, ConfirmDialogComponent } = useConfirmDialog();

    return (
        <div className={`rounded-bubble border transition-[background-color,border-color,opacity,box-shadow] duration-[150ms] ease-[var(--ease-snappy)] ${instruction.isActive ? 'bg-zinc-900 border-zinc-600 shadow-[0_0_15px_-5px_rgba(176, 176, 182,0.1)]' : 'bg-zinc-800 border-hairline opacity-80 hover:opacity-100'}`}>
            <div className="p-3 flex items-center justify-between gap-3">
                <div className="flex-1 flex items-center gap-3 min-w-0">
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="p-1 rounded-control hover:bg-zinc-800 transition-colors text-zinc-500 hover:text-zinc-300"
                    >
                        <ChevronDownIcon className={`w-4 h-4 transition-transform duration-[150ms] ease-[var(--ease-snappy)] ${isExpanded ? 'rotate-180' : ''}`} />
                    </button>

                    <div className="flex-1 min-w-0">
                        {isExpanded ? (
                            <input
                                type="text"
                                value={instruction.title}
                                onChange={(e) => onUpdate(instruction.id, { title: e.target.value })}
                                className="w-full bg-zinc-950 border border-hairline rounded-control px-2 py-1 text-ui-sm text-white font-bold focus:border-accent/50 outline-none"
                                placeholder="Instruction Title"
                            />
                        ) : (
                            <div className="flex items-center gap-2">
                                <span className={`text-ui-sm font-bold truncate ${instruction.isActive ? 'text-cyan-100' : 'text-zinc-400'}`} title={instruction.title || 'Untitled'}>{instruction.title || 'Untitled'}</span>
                                {instruction.isActive && <StatusPill tone="info" kicker>Active</StatusPill>}
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <ToggleSwitch
                        checked={instruction.isActive}
                        onChange={() => onUpdate(instruction.id, { isActive: !instruction.isActive })}
                        label={instruction.isActive ? 'Deactivate instruction' : 'Activate instruction'}
                    />

                    <button
                        onClick={async () => {
                            const ok = await confirmDelete({ title: 'Delete this instruction?', message: 'This cannot be undone.', confirmLabel: 'Delete' });
                            if (ok) onDelete(instruction.id);
                        }}
                        className="p-1.5 text-zinc-600 hover:text-rose-400 hover:bg-rose-500/10 rounded-control transition-colors"
                        title="Delete"
                    >
                        <TrashIcon className="w-4 h-4" aria-hidden="true" />
                    </button>
                </div>
            </div>
            {ConfirmDialogComponent}

            {isExpanded && (
                <div className="px-3 pb-3 animate-fade-in border-t border-hairline pt-3">
                    <textarea
                        value={instruction.content}
                        onChange={(e) => onUpdate(instruction.id, { content: e.target.value })}
                        placeholder="Enter instruction content..."
                        className="w-full h-32 bg-zinc-950 border border-hairline rounded-control p-3 text-ui-sm text-zinc-300 focus:outline-none focus:border-accent/30 resize-none leading-relaxed custom-scrollbar font-mono"
                    />
                    <div className="flex justify-end mt-2">
                        <span className="text-ui-xs text-zinc-500">
                            {instruction.content.trim().split(/\s+/).filter(Boolean).length} words
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
};

// Props interface
export interface CustomInstructionsEditorProps {
    customInstructions: CustomInstructionsMap;
    setCustomInstructions: (instructions: CustomInstructionsMap) => void;
    activeTab: InstructionTab;
    onTabChange: (tab: InstructionTab) => void;
}

const CustomInstructionsEditor: React.FC<CustomInstructionsEditorProps> = ({
    customInstructions,
    setCustomInstructions,
    activeTab,
    onTabChange,
}) => {
    const currentInstructions = useMemo(() => customInstructions[activeTab] || [], [customInstructions, activeTab]);

    const totalWordCount = useMemo(() => {
        return currentInstructions.reduce((sum, inst) => sum + (inst.content ? inst.content.trim().split(/\s+/).filter(Boolean).length : 0), 0);
    }, [currentInstructions]);

    const handleAddInstruction = () => {
        if (currentInstructions.length >= MAX_ITEMS) {
            return; // Button is disabled at limit; guard for safety
        }

        const newInstruction: CustomInstruction = {
            id: `inst-${Date.now()}`,
            title: `New Instruction ${currentInstructions.length + 1}`,
            content: '',
            isActive: true
        };

        setCustomInstructions({
            ...customInstructions,
            [activeTab]: [...currentInstructions, newInstruction]
        });
    };

    const handleUpdateInstruction = (id: string, updates: Partial<CustomInstruction>) => {
        const updatedList = currentInstructions.map(inst => inst.id === id ? { ...inst, ...updates } : inst);
        setCustomInstructions({
            ...customInstructions,
            [activeTab]: updatedList
        });
    };

    const handleDeleteInstruction = (id: string) => {
        setCustomInstructions({
            ...customInstructions,
            [activeTab]: currentInstructions.filter(inst => inst.id !== id)
        });
    };

    return (
        <div className="flex-1 overflow-y-auto pb-6 space-y-4 custom-scrollbar">
            <SettingsPageHeader
                title="Instructions"
                description="Define multiple custom instruction sets for how the AI should reason, behave, or filter trades. Select the mode below to manage its instructions."
            />

            {/* Tabs for Mode Selection */}
            <div className="flex space-x-1 bg-zinc-900 p-1 rounded-control border border-hairline">
                <button
                    onClick={() => onTabChange('general')}
                    className={`flex-1 py-1.5 text-ui-xs font-bold uppercase tracking-wider rounded-control transition-colors duration-[150ms] ease-[var(--ease-snappy)] ${activeTab === 'general' ? 'bg-zinc-700 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    Standard
                </button>
            </div>

            {/* Word Count Progress */}
            <div className="bg-zinc-800 rounded-bubble p-3 border border-hairline">
                <div className="flex justify-between items-center text-ui-xs font-mono mb-1.5">
                    <span className="text-zinc-500 uppercase font-bold tracking-wider">Token Usage</span>
                    <span className={`${totalWordCount > MAX_WORD_COUNT ? 'text-rose-400 font-bold' : 'text-zinc-400'}`}>
                        {totalWordCount} / {MAX_WORD_COUNT} words
                    </span>
                </div>
                <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                        // Data-value motion: this animates the token-usage bar's width,
                        // so the 500ms stays (ui-doctrine "Motion and density" exception).
                        className={`h-full rounded-full transition-[width,background-color] duration-500 ease-[var(--ease-snappy)] ${totalWordCount > MAX_WORD_COUNT ? 'bg-rose-500' : 'bg-cyan-600'}`}
                        style={{ width: `${Math.min(100, (totalWordCount / MAX_WORD_COUNT) * 100)}%` }}
                    ></div>
                </div>
            </div>

            {/* Instruction List */}
            <div className="space-y-3">
                {currentInstructions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10 text-center border border-dashed border-hairline rounded-bubble">
                        <span className="text-3xl mb-3"></span>
                        <p className="text-ui-sm text-zinc-600 italic">No custom instructions for this mode yet.</p>
                    </div>
                ) : (
                    currentInstructions.map(inst => (
                        <InstructionCard
                            key={inst.id}
                            instruction={inst}
                            onUpdate={handleUpdateInstruction}
                            onDelete={handleDeleteInstruction}
                        />
                    ))
                )}
            </div>

            {/* Add Button */}
            <button
                onClick={handleAddInstruction}
                disabled={currentInstructions.length >= MAX_ITEMS}
                className="w-full py-3 rounded-control border border-hairline bg-zinc-800 hover:bg-zinc-700 text-ui-sm font-bold uppercase tracking-wider text-zinc-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
                + Add New Instruction ({currentInstructions.length}/{MAX_ITEMS})
            </button>
        </div>
    );
};

export default CustomInstructionsEditor;
