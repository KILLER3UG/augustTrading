import React from 'react';

/**
 * AuditPanel: the ONE container language for every audit surface
 * on a settled verdict card — run contract, evidence pack, used-notes strip,
 * run log. Identical radius / border / background so a stack
 * of panels reads as one grouped system instead of five competing boxes.
 *
 * Purely presentational; content owns its own typography.
 */
const AuditPanel: React.FC<{
    children: React.ReactNode;
    className?: string;
}> = ({ children, className = '' }) => (
    <div className={`rounded-control border border-hairline bg-white/[0.015] px-3 py-2 ${className}`.trim()}>
        {children}
    </div>
);

export default AuditPanel;
