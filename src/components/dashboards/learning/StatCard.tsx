
import React from 'react';

export interface StatCardItem {
    name: string;
    value: string;
    subtext?: string;
    color?: string;
}

// Stat card component
export const StatCard: React.FC<{
    title: string;
    items: StatCardItem[];
    emptyText?: string;
}> = ({ title, items, emptyText = 'Not enough data' }) => (
    <div className="bg-zinc-800 rounded-bubble border border-hairline p-3 sm:p-4">
        <h4 className="text-ui-xs sm:text-ui-sm font-bold text-zinc-500 uppercase tracking-wider mb-2 sm:mb-3">{title}</h4>
        {items.length > 0 ? (
            <div className="space-y-2">
                {items.map((item, i) => (
                    <div key={i} className="flex items-center justify-between">
                        <span className="text-ui-base text-zinc-300 truncate pr-2" title={item.name}>{item.name}</span>
                        <div className="text-right">
                            <span className={`text-ui-base font-bold ${item.color || 'text-white'}`}>{item.value}</span>
                            {item.subtext && <span className="text-ui-xs text-zinc-500 ml-1">{item.subtext}</span>}
                        </div>
                    </div>
                ))}
            </div>
        ) : (
            <p className="text-ui-sm text-zinc-600 italic">{emptyText}</p>
        )}
    </div>
);

export default StatCard;
