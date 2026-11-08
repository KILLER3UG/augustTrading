
import React, { useState, useEffect } from 'react';
import { StrategySearchResult } from '../../types';
import { searchStrategies, discoverStrategies, getStrategyDescription } from '../../services/providers/GenericAnalysisService';
import { ProviderConfig } from '../../types/provider';
import { CloseIcon, LoadingIcon, BotIcon, CheckIcon, LockIcon, ChevronDownIcon, SearchIcon, BrainIcon } from './Icons';
import { FAMILY_UI_DATA } from '../../constants/models';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface StrategySearchProps {
  isVisible: boolean;
  onClose: () => void;
  onApplyStrategy: (strategyName: string) => void;
  onRemoveStrategy: (strategyName: string) => void;
  providerConfig: ProviderConfig;
  activeFrameworks: string[];
  defaultFrameworks: string[];
  initialViewStrategy?: string | null;
  onQuotaExceeded: (modelId: string) => void;
  familyWinRates: Record<string, { total: number; wins: number; winRate: number }>;
}

const isQuotaError = (error: any): boolean => {
  if (error && error.status === 429) return true;
  const message = (error?.message || '').toLowerCase();
  return message.includes('quota') || (message.includes('resource has been exhausted') && (message.includes('requests per minute') || message.includes('daily') || message.includes('monthly')));
};

const StrategySearch: React.FC<StrategySearchProps> = ({ 
    isVisible, 
    onClose, 
    onApplyStrategy,
    onRemoveStrategy,
    providerConfig,
    activeFrameworks,
    defaultFrameworks,
    initialViewStrategy,
    onQuotaExceeded,
    familyWinRates
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<StrategySearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFrameworksVisible, setIsFrameworksVisible] = useState(true);
  const [isFamiliesVisible, setIsFamiliesVisible] = useState(false);
  const [viewingFramework, setViewingFramework] = useState<string | null>(null);
  const [frameworkDescription, setFrameworkDescription] = useState<string>('');
  const [isFetchingDescription, setIsFetchingDescription] = useState<boolean>(false);

  useEffect(() => {
    if (!isVisible) {
      setSearchQuery('');
      setSearchResults([]);
      setIsLoading(false);
      setError(null);
      setViewingFramework(null);
      setFrameworkDescription('');
      setIsFamiliesVisible(false); // Reset
    }
  }, [isVisible]);

  useEffect(() => {
    if (isVisible && initialViewStrategy) {
      setIsFrameworksVisible(true); 
      handleViewFrameworkDetails(initialViewStrategy);
    }
  }, [isVisible, initialViewStrategy]);

  // Keyboard support: Escape closes; focus is trapped + restored (this panel
  // was previously keyboard-dead — divs-as-buttons and no dismissal path).
  const drawerRef = useFocusTrap<HTMLElement>(isVisible);
  useEscapeClose(isVisible, onClose);

   const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsLoading(true);
    setError(null);
    setSearchResults([]);
    try {
        const results = await searchStrategies(providerConfig, searchQuery, activeFrameworks);
        setSearchResults(results);
        if (results.length === 0) {
            setError("No matching strategies found within your playbook.");
        }
    } catch (err: any) {
        if (isQuotaError(err)) {
            onQuotaExceeded(providerConfig.selectedModel);
            setError(`Quota exceeded for the selected ${providerConfig.name} model.`);
        } else {
            setError(err instanceof Error ? err.message : 'An unknown error occurred.');
        }
    } finally {
        setIsLoading(false);
    }
  };

  const handleDiscover = async () => {
    setIsLoading(true);
    setError(null);
    setSearchResults([]);
    setSearchQuery('');
    try {
        const results = await discoverStrategies(providerConfig, [], activeFrameworks);
        setSearchResults(results);
        if (results.length === 0) {
            setError("Could not discover any relevant strategies at this time.");
        }
    } catch (err: any) {
        if (isQuotaError(err)) {
            onQuotaExceeded(providerConfig.selectedModel);
            setError("Quota exceeded for the selected Gemini model.");
        } else {
            setError(err instanceof Error ? err.message : 'An unknown error occurred.');
        }
    } finally {
        setIsLoading(false);
    }
  };

  const handleViewFrameworkDetails = async (frameworkName: string) => {
    if (viewingFramework === frameworkName) {
        setViewingFramework(null);
        return;
    }
    setViewingFramework(frameworkName);
    setIsFetchingDescription(true);
    setFrameworkDescription('');
    try {
        const description = await getStrategyDescription(providerConfig, frameworkName);
        setFrameworkDescription(description);
    } catch (err: any) {
        if (isQuotaError(err)) {
            onQuotaExceeded(providerConfig.selectedModel);
            setFrameworkDescription(`Quota exceeded for the selected ${providerConfig.name} model. Please select a different model from the main view and try again.`);
        } else if (err.status === 429 || (err.message && err.message.includes('Too Many Requests'))) {
            setFrameworkDescription("Rate limit exceeded. Please try again later.");
        } else {
            setFrameworkDescription(err instanceof Error ? err.message : 'Failed to load description.');
        }
    } finally {
        setIsFetchingDescription(false);
    }
  };

  // Family frames are CATEGORICAL markers (which family this card is), never a
  // gain/loss/warning read — the win-rate badge inside each card is the only
  // semantic color in this list.
  const getFamilyColorClasses = (color: string) => {
      switch(color) {
          case 'red': return 'bg-rose-500/10 border-rose-500/30 text-rose-400';
          case 'emerald': return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400';
          case 'blue': return 'bg-amber-500/10 border-amber-500/30 text-amber-400';
          case 'purple': return 'bg-zinc-800/60 border-zinc-700/50 text-zinc-300';
          default: return 'bg-zinc-800 border-zinc-600 text-zinc-300';
      }
  };

  return (
    <>
      <div 
        className={`fixed inset-0 bg-black/60 z-40 transition-opacity duration-[150ms] ${isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
        aria-hidden={!isVisible}
      ></div>

      {/* aria-modal/aria-hidden ride the REAL visibility: a permanently
          mounted drawer that claims modal while closed hides the entire
          rest of the app from the accessibility tree (screen readers AND
          Playwright's role engine) — closed, the drawer must not exist
          a11y-wise. inert blocks the tab ring into the off-screen panel. */}
      <aside
        ref={drawerRef}
        role={isVisible ? 'dialog' : undefined}
        aria-modal={isVisible || undefined}
        aria-hidden={!isVisible}
        inert={!isVisible}
        aria-label="Playbook & Strategy Search"
        className={`fixed top-0 right-0 h-full w-full sm:w-[480px] bg-zinc-900 border-l border-hairline shadow-2xl z-drawer transform transition-transform duration-[150ms] ease-[var(--ease-snappy)] flex flex-col ${isVisible ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex flex-col h-full">
          <header className="flex items-center justify-between p-4 sm:p-6 border-b border-hairline bg-zinc-800">
            <h2 className="text-lg sm:text-xl font-bold text-cyan-400 tracking-tight">Playbook & Discovery</h2>
            <button onClick={onClose} className="p-2 sm:p-3 rounded-control text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors" aria-label="Close strategy search">
              <CloseIcon className="w-5 h-5 sm:w-6 sm:h-6" aria-hidden="true" />
            </button>
          </header>
          
          <div className="p-4 sm:p-6 border-b border-hairline bg-zinc-800">
             <form onSubmit={handleSearch} className="flex gap-2 sm:gap-3 mb-3 sm:mb-5">
                <div className="relative flex-1">
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search..."
                        className="w-full bg-zinc-950 border border-hairline rounded-control pl-4 sm:pl-5 pr-10 sm:pr-12 py-3 sm:py-4 text-ui-base sm:text-ui-lg text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus:border-accent/50 transition-[border-color,box-shadow] duration-[150ms] ease-[var(--ease-snappy)]"
                    />
                    <button
                        type="submit"
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-control text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                        disabled={isLoading || !searchQuery.trim()}
                        aria-label="Search strategies"
                    >
                        <SearchIcon className="w-4 h-4 sm:w-5 sm:h-5" aria-hidden="true" />
                    </button>
                </div>
             </form>
             <button
                onClick={handleDiscover}
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-2 sm:gap-3 bg-accent/15 hover:bg-accent/25 text-accent border border-accent/40 font-bold py-3 sm:py-4 px-4 sm:px-5 rounded-control transition-colors duration-[150ms] ease-[var(--ease-snappy)] disabled:opacity-50 disabled:cursor-not-allowed text-ui-sm sm:text-ui-lg"
             >
                <BotIcon /> Auto-Discover Strategies
             </button>
             <p className="text-ui-xs sm:text-ui-sm text-zinc-600 text-center mt-2 sm:mt-4 font-medium">
                Use AI to research and add new frameworks from the web.
             </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 sm:space-y-10 pb-12">
            {isLoading && <div className="flex justify-center py-8"><LoadingIcon className="w-8 h-8 sm:w-10 sm:h-10 text-cyan-500" aria-hidden="true" /></div>}
            {error && <div className="text-ui-sm sm:text-ui-base text-rose-300 p-4 sm:p-5 bg-rose-500/10 rounded-control border border-rose-500/20">{error}</div>}
            
            {(searchResults || []).length > 0 && (
                <div className="space-y-3 sm:space-y-5">
                    <h3 className="text-ui-sm sm:text-ui-base font-bold text-zinc-500 uppercase tracking-widest pl-1">Discovery Results</h3>
                    {(searchResults || []).map((result) => (
                        <div key={result.name} className="p-4 sm:p-6 bg-zinc-800 rounded-bubble border border-hairline hover:border-cyan-500/30 transition-colors animate-fade-in">
                           <div className="flex justify-between items-start mb-3 sm:mb-4">
                                <h4 className="font-bold text-cyan-400 text-lg sm:text-xl">{result.name}</h4>
                                <button 
                                    onClick={() => onApplyStrategy(result.name)}
                                    disabled={(activeFrameworks || []).some(fw => fw.toLowerCase() === result.name.toLowerCase())}
                                    className={`text-ui-xs sm:text-ui-sm font-bold uppercase tracking-wider py-2 px-4 rounded-control transition-colors ${
                                        (activeFrameworks || []).some(fw => fw.toLowerCase() === result.name.toLowerCase())
                                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 cursor-default'
                                        : 'bg-accent text-accent-ink hover:bg-amber-500 shadow-lg shadow-black/30'
                                    }`}
                                >
                                    {(activeFrameworks || []).some(fw => fw.toLowerCase() === result.name.toLowerCase()) ? 'Active' : 'Add'}
                                </button>
                           </div>
                           <p className="text-ui-base sm:text-ui-lg text-zinc-300 leading-relaxed">{result.description}</p>
                           {result.rationale && <div className="mt-3 sm:mt-4 pt-3 sm:pt-4 border-t border-hairline"><p className="text-ui-sm sm:text-ui-base text-zinc-500 italic">Rationale: {result.rationale}</p></div>}
                        </div>
                    ))}
                </div>
            )}
            
            {/* Market Structure Families Section */}
            <div>
                <button
                    type="button"
                    onClick={() => setIsFamiliesVisible(!isFamiliesVisible)}
                    aria-expanded={isFamiliesVisible}
                    className="w-full flex justify-between items-center cursor-pointer py-3 sm:py-4 group text-left"
                >
                    <h3 className="text-ui-sm sm:text-ui-base font-bold text-zinc-500 uppercase tracking-widest group-hover:text-zinc-300 transition-colors flex items-center gap-2">
                        <BrainIcon className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-600" aria-hidden="true" />
                        Market Classification Families
                    </h3>
                    <ChevronDownIcon className={`w-4 h-4 sm:w-5 sm:h-5 text-zinc-600 transition-transform duration-[150ms] ${isFamiliesVisible ? 'rotate-180' : ''}`} />
                </button>
                
                <div className={`collapsible-content ${isFamiliesVisible ? 'expanded' : ''}`}>
                    <div className="mt-2 sm:mt-4 space-y-3 sm:space-y-5">
                        <p className="text-ui-sm sm:text-ui-base text-zinc-500 px-1">Pattern-recognition models used for probability forecasting.</p>
                        <div className="grid grid-cols-1 gap-3 sm:gap-5">
                            {FAMILY_UI_DATA.map(family => {
                                const stats = familyWinRates[family.name] || { total: 0, wins: 0, winRate: 0 };
                                return (
                                    <div key={family.id} className={`p-4 sm:p-6 rounded-bubble border ${getFamilyColorClasses(family.color)} bg-opacity-10`}>
                                        <div className="flex justify-between items-start mb-2 sm:mb-4">
                                            <h4 className="font-black uppercase tracking-tight text-ui-base sm:text-ui-lg flex items-center gap-2">
                                                {family.name}
                                                {stats.total > 0 ? (
                                                    <span className={`text-ui-xs sm:text-ui-sm px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-control font-bold ${parseInt(String(stats.winRate)) > 50 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`}>
                                                        {stats.winRate}% Win
                                                    </span>
                                                ) : (
                                                    <span className="text-ui-xs sm:text-ui-sm px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-control font-bold bg-zinc-700 text-zinc-400">N/A</span>
                                                )}
                                            </h4>
                                            <span className={`text-ui-micro sm:text-ui-xs font-bold uppercase px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-control bg-black/30 border border-hairline`}>{family.tag}</span>
                                        </div>
                                        <p className="text-ui-base sm:text-ui-lg font-bold opacity-90 mb-1 sm:mb-2">"{family.nickname}"</p>
                                        <p className="text-ui-sm sm:text-ui-base opacity-80 mb-3 sm:mb-5 leading-relaxed">{family.personality}</p>
                                        
                                        <div className="space-y-2 sm:space-y-4">
                                            <div>
                                                <span className="text-ui-xs sm:text-ui-sm font-bold uppercase opacity-60 block mb-1 sm:mb-2">Typical Features</span>
                                                <ul className="list-disc list-inside text-ui-xs sm:text-ui-base opacity-80 space-y-0.5 sm:space-y-1">
                                                    {family.features.slice(0, 3).map((f, i) => <li key={i}>{f}</li>)}
                                                </ul>
                                            </div>
                                            <div className="pt-2 sm:pt-3 border-t border-hairline">
                                                <span className="text-ui-xs sm:text-ui-sm font-bold uppercase opacity-60 block mb-0.5 sm:mb-1">Outcome Tendency</span>
                                                <p className="text-ui-xs sm:text-ui-base opacity-90 italic">{family.tendency}</p>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>

            {/* Core Frameworks Section */}
            <div>
                    <button
                        type="button"
                        onClick={() => setIsFrameworksVisible(!isFrameworksVisible)}
                        aria-expanded={isFrameworksVisible}
                        className="w-full flex justify-between items-center cursor-pointer py-3 sm:py-4 group text-left"
                    >
                        <h3 className="text-ui-sm sm:text-ui-base font-bold text-zinc-500 uppercase tracking-widest group-hover:text-zinc-300 transition-colors">Active Playbook</h3>
                        <ChevronDownIcon className={`w-4 h-4 sm:w-5 sm:h-5 text-zinc-600 transition-transform duration-[150ms] ${isFrameworksVisible ? 'rotate-180' : ''}`} />
                    </button>
                
                <div className={`collapsible-content ${isFrameworksVisible ? 'expanded' : ''}`}>
                    <div className="space-y-2 sm:space-y-3 mt-1 sm:mt-2">
                        {(activeFrameworks || []).length === 0 && <p className="text-zinc-500 italic p-4 text-center text-ui-base">No active strategies.</p>}
                        
                        {(activeFrameworks || []).map((framework, index) => {
                            const isDefault = defaultFrameworks.includes(framework);
                            const isViewing = viewingFramework === framework;
                            
                            return (
                                <div key={index} className={`rounded-bubble overflow-hidden border transition-[border-color,box-shadow] duration-[150ms] ease-[var(--ease-snappy)] ${isViewing ? 'bg-zinc-800 border-cyan-500/30 shadow-lg' : 'bg-zinc-800 border-hairline hover:border-line'}`}>
                                    <div 
                                        className="p-3 sm:p-5 flex items-center justify-between cursor-pointer"
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => handleViewFrameworkDetails(framework)}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleViewFrameworkDetails(framework); } }}
                                    >
                                        <div className="flex items-center gap-3">
                                            {isDefault ? <LockIcon /> : <CheckIcon className="text-cyan-500" aria-hidden="true" />}
                                            <span className={`font-bold text-ui-base sm:text-ui-lg ${isViewing ? 'text-cyan-400' : 'text-zinc-300'}`}>{framework}</span>
                                        </div>
                                        <div className="flex items-center gap-2 sm:gap-3">
                                            {!isDefault && (
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); onRemoveStrategy(framework); }}
                                                    className="p-1.5 sm:p-2 text-zinc-600 hover:text-rose-400 hover:bg-rose-500/10 rounded-control transition-colors"
                                                    aria-label={`Remove ${framework}`}
                                                >
                                                    <CloseIcon className="w-3 h-3 sm:w-4 sm:h-4" aria-hidden="true" />
                                                </button>
                                            )}
                                            <ChevronDownIcon className={`w-4 h-4 sm:w-5 sm:h-5 text-zinc-600 transition-transform ${isViewing ? 'rotate-180' : ''}`} />
                                        </div>
                                    </div>
                                    
                                    {isViewing && (
                                        <div className="px-3 sm:px-5 pb-3 sm:pb-5 pt-0 animate-fade-in border-t border-hairline mt-1 sm:mt-2">
                                            <div className="pt-2 sm:pt-4">
                                                {isFetchingDescription ? (
                                                    <div className="flex items-center gap-2 sm:gap-3 text-zinc-500">
                                                        <LoadingIcon className="w-3 h-3 sm:w-4 sm:h-4" aria-hidden="true" />
                                                        <span className="text-ui-sm sm:text-ui-base">Retrieving strategy details...</span>
                                                    </div>
                                                ) : (
                                                    <p className="text-ui-base sm:text-ui-lg text-zinc-300 leading-relaxed">{frameworkDescription}</p>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

          </div>
        </div>
      </aside>
    </>
  );
};

export default StrategySearch;
