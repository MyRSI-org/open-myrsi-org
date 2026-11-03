import React from 'react';
import { HydratedOperation, OperationStatus } from '../../../../../types';
import SearchResultCard from '../SearchResultCard';
import {
    operationStatusAccent,
    operationStatusIcon,
    clearanceAccent,
    timeAgoShort,
} from '../../../operations/operations/operationStyles';
import { ACCENTS } from '../../../../shared/ui/accents';
import { displayRoster } from '../../../operations/participantRoster';

interface Props {
    operation: HydratedOperation;
    onClick: () => void;
    isSelected?: boolean;
}

const OperationRowContent: React.FC<Props> = ({ operation, onClick, isSelected }) => {
    const accent = operationStatusAccent(operation.status);
    const isActive = operation.status === OperationStatus.Active;
    const shortId = operation.id.split('-')[1]?.toUpperCase() ?? operation.id.slice(0, 8).toUpperCase();
    const clearanceA = (operation.clearanceLevel || 0) > 0
        ? ACCENTS[clearanceAccent(operation.clearanceLevel)]
        : null;
    // Concluded ops count everyone who was on the roster at conclusion (concluding stamps
    // time_left on every row); other ops count active rows only. Same rule as OperationCard.
    const activeParticipants = displayRoster(operation).length;
    return (
        <SearchResultCard
            accent={accent}
            pulseRail={isActive}
            icon={operationStatusIcon(operation.status)}
            onClick={onClick}
            isSelected={isSelected}
        >
            <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[10px] text-slate-500 tracking-wider shrink-0">OP-{shortId}</span>
                <span className="text-slate-700 shrink-0">·</span>
                <h3 className="text-white font-bold text-sm truncate">{operation.name}</h3>
                <span className="text-slate-700 shrink-0">·</span>
                <span className="text-[10px] text-slate-500 font-mono whitespace-nowrap">
                    <i className="fa-regular fa-clock mr-1" aria-hidden />
                    {timeAgoShort(operation.updatedAt || operation.createdAt)}
                </span>
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
                <span className="px-1.5 py-0.5 rounded-sm border bg-slate-900/60 border-white/10 text-slate-400 font-mono text-[10px] uppercase tracking-wider shrink-0">
                    {operation.type}
                </span>
                {clearanceA && (
                    <span className={`px-1.5 py-0.5 rounded-sm border font-black text-[9px] uppercase tracking-widest shrink-0 ${clearanceA.bg} ${clearanceA.border} ${clearanceA.text}`}>
                        <i className="fa-solid fa-shield-halved mr-1" aria-hidden />
                        LVL {operation.clearanceLevel}
                    </span>
                )}
                <span className="text-[10px] text-slate-400 truncate min-w-0 flex-1">
                    <i className="fa-solid fa-crown text-amber-500 mr-1" aria-hidden />
                    {operation.owner?.name || 'Unknown'}
                </span>
                <span className="text-[10px] text-slate-500 font-mono shrink-0">
                    <i className="fa-solid fa-users mr-1" aria-hidden />
                    {activeParticipants}
                </span>
                <span className={`px-1.5 py-0.5 rounded-sm border font-black text-[9px] uppercase tracking-widest shrink-0 ${ACCENTS[accent].bg} ${ACCENTS[accent].border} ${ACCENTS[accent].text}`}>
                    {operation.status}
                </span>
            </div>
        </SearchResultCard>
    );
};

export default React.memo(OperationRowContent);
