
import React, { useState, useMemo } from 'react';
import { HydratedOperation, OperationStatus, OperationType } from '../../../types';

import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import { useOperations } from '../../../contexts/OperationsContext';
import { useNavigation } from '../../../contexts/NavigationContext';

const getTypeColor = (type: OperationType) => {
    switch (type) {
        case OperationType.PvP: return { bg: 'bg-red-500/20', border: 'border-red-500/40', text: 'text-red-300', dot: 'bg-red-500' };
        case OperationType.PvE: return { bg: 'bg-orange-500/20', border: 'border-orange-500/40', text: 'text-orange-300', dot: 'bg-orange-500' };
        case OperationType.Mixed: return { bg: 'bg-purple-500/20', border: 'border-purple-500/40', text: 'text-purple-300', dot: 'bg-purple-500' };
        case OperationType.Training: return { bg: 'bg-emerald-500/20', border: 'border-emerald-500/40', text: 'text-emerald-300', dot: 'bg-emerald-500' };
        case OperationType.Social: return { bg: 'bg-purple-500/20', border: 'border-purple-500/40', text: 'text-purple-300', dot: 'bg-purple-500' };
        case OperationType.NonCombat:
        default: return { bg: 'bg-sky-500/20', border: 'border-sky-500/40', text: 'text-sky-300', dot: 'bg-sky-500' };
    }
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface OpBlockProps {
    op: HydratedOperation;
    compact?: boolean;
    viewOperationDetails: (op: HydratedOperation) => void;
    formatTime: (dateStr: string) => string;
}

const OpBlock: React.FC<OpBlockProps> = ({ op, compact, viewOperationDetails, formatTime }) => {
    const colors = getTypeColor(op.type);
    const activeParticipants = op.participants.filter(p => p.timeLeft === null).length;
    const accepted = op.participants.filter(p => p.rsvpStatus === 'Accepted').length;
    const isConcluded = op.status === OperationStatus.Concluded;
    const displayTime = op.scheduledStart || op.activeStartTime;

    return (
        <div
            onClick={(e) => { e.stopPropagation(); viewOperationDetails(op); }}
            className={`${colors.bg} ${colors.border} border rounded-md cursor-pointer hover:brightness-125 transition-all ${compact ? 'px-1.5 py-0.5' : 'px-2 py-1.5'} ${isConcluded ? 'opacity-40' : ''}`}
        >
            <div className="flex items-center gap-1.5 min-w-0">
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors.dot} ${op.status === OperationStatus.Active ? 'animate-pulse' : ''}`}></div>
                <span className={`${colors.text} font-bold truncate ${compact ? 'text-[9px]' : 'text-[10px]'}`}>
                    {compact ? op.name : `${displayTime ? formatTime(displayTime) : ''} ${op.name}`}
                </span>
            </div>
            {!compact && (
                <div className="flex items-center gap-2 mt-0.5 ml-3">
                    <span className="text-[9px] text-slate-500">
                        <i className="fa-solid fa-users mr-0.5"></i>{accepted > 0 ? `${accepted} RSVP` : `${activeParticipants} PAX`}
                    </span>
                    {isConcluded && <span className="text-[9px] text-slate-600 italic">Concluded</span>}
                </div>
            )}
        </div>
    );
};

interface OperationsCalendarViewProps {
    operations: HydratedOperation[];
}

const OperationsCalendarView: React.FC<OperationsCalendarViewProps> = ({ operations }) => {
    const { viewOperationDetails } = useNavigation();
    const { hasPermission } = useAuth();
    const { updateOperationStatus } = useOperations();
    const fmt = useFormatDate();
    const [viewMode, setViewMode] = useState<'month' | 'week' | 'day'>('month');
    const [currentDate, setCurrentDate] = useState(() => new Date());

    // Include both scheduled ops and active ops (on their active start date)
    const calendarOps = useMemo(() => {
        return operations.filter(op => op.scheduledStart || op.activeStartTime);
    }, [operations]);

    const getOpsForDate = (date: Date) => {
        return calendarOps.filter(op => {
            // Use scheduledStart if available, fall back to activeStartTime
            const dateStr = op.scheduledStart || op.activeStartTime;
            if (!dateStr) return false;
            const start = new Date(dateStr);
            return start.getFullYear() === date.getFullYear() &&
                start.getMonth() === date.getMonth() &&
                start.getDate() === date.getDate();
        });
    };

    const navigate = (dir: number) => {
        const d = new Date(currentDate);
        if (viewMode === 'month') d.setMonth(d.getMonth() + dir);
        else if (viewMode === 'week') d.setDate(d.getDate() + dir * 7);
        else d.setDate(d.getDate() + dir);
        setCurrentDate(d);
    };

    const goToToday = () => setCurrentDate(new Date());

    const monthDays = useMemo(() => {
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth();
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const daysInPrevMonth = new Date(year, month, 0).getDate();

        const days: { date: Date; isCurrentMonth: boolean }[] = [];

        for (let i = firstDay - 1; i >= 0; i--) {
            days.push({ date: new Date(year, month - 1, daysInPrevMonth - i), isCurrentMonth: false });
        }
        for (let i = 1; i <= daysInMonth; i++) {
            days.push({ date: new Date(year, month, i), isCurrentMonth: true });
        }
        const remaining = 42 - days.length;
        for (let i = 1; i <= remaining; i++) {
            days.push({ date: new Date(year, month + 1, i), isCurrentMonth: false });
        }
        return days;
    }, [currentDate]);

    const weekDays = useMemo(() => {
        const d = new Date(currentDate);
        d.setDate(d.getDate() - d.getDay());
        const days: Date[] = [];
        for (let i = 0; i < 7; i++) {
            days.push(new Date(d));
            d.setDate(d.getDate() + 1);
        }
        return days;
    }, [currentDate]);

    const today = new Date();
    const isToday = (date: Date) =>
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate();

    const formatTime = (dateStr: string) => fmt.time(dateStr);

    const dayOps = getOpsForDate(currentDate).slice().sort((a, b) => {
        const aTime = a.scheduledStart || a.activeStartTime || '';
        const bTime = b.scheduledStart || b.activeStartTime || '';
        return new Date(aTime).getTime() - new Date(bTime).getTime();
    });

    return (
        <div className="flex flex-col h-full bg-slate-900/60 backdrop-blur-md border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5 bg-white/5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-center gap-2">
                    <button onClick={() => navigate(-1)} className="w-8 h-8 flex items-center justify-center rounded-lg bg-slate-900/60 border border-slate-700 text-slate-400 hover:text-white hover:border-purple-500/40 hover:bg-purple-500/10 transition-colors">
                        <i className="fa-solid fa-chevron-left text-xs"></i>
                    </button>
                    <h2 className="text-sm sm:text-base font-black text-white uppercase tracking-wider min-w-[180px] sm:min-w-[220px] text-center px-2">
                        {viewMode === 'month' && `${MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`}
                        {viewMode === 'week' && weekDays[0] && `Week of ${fmt.date(weekDays[0].toISOString())}`}
                        {viewMode === 'day' && fmt.date(currentDate.toISOString())}
                    </h2>
                    <button onClick={() => navigate(1)} className="w-8 h-8 flex items-center justify-center rounded-lg bg-slate-900/60 border border-slate-700 text-slate-400 hover:text-white hover:border-purple-500/40 hover:bg-purple-500/10 transition-colors">
                        <i className="fa-solid fa-chevron-right text-xs"></i>
                    </button>
                    <button onClick={goToToday} className="ml-1 px-3 py-1.5 rounded-lg bg-slate-900/60 border border-slate-700 text-slate-300 hover:text-white hover:border-purple-500/40 hover:bg-purple-500/10 transition-colors text-[10px] font-black uppercase tracking-wider">
                        Today
                    </button>
                </div>
                <div className="flex bg-slate-900/60 rounded-lg border border-slate-700 p-0.5">
                    {(['month', 'week', 'day'] as const).map(mode => (
                        <button
                            key={mode}
                            onClick={() => setViewMode(mode)}
                            className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${
                                viewMode === mode ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'text-slate-500 hover:text-slate-300 border border-transparent'
                            }`}
                        >
                            {mode}
                        </button>
                    ))}
                </div>
            </div>

            <div className="px-5 pt-3 pb-2 flex items-center gap-3 flex-wrap text-[9px] font-black uppercase tracking-widest border-b border-white/5">
                {Object.values(OperationType).map(type => {
                    const colors = getTypeColor(type);
                    return (
                        <span key={type} className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border ${colors.bg} ${colors.border} ${colors.text}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`}></span>
                            {type}
                        </span>
                    );
                })}
            </div>

            <div className="flex-1 flex flex-col min-h-0 p-5">
            {viewMode === 'month' && (
                <div className="flex-1 flex flex-col min-h-0">
                    <div className="grid grid-cols-7 border-b border-slate-700/50 mb-1">
                        {DAYS.map(day => (
                            <div key={day} className="text-center py-2 text-[10px] font-black text-slate-500 uppercase tracking-widest">{day}</div>
                        ))}
                    </div>
                    <div className="grid grid-cols-7 flex-1 auto-rows-fr gap-px bg-slate-800/30 rounded-lg overflow-hidden">
                        {monthDays.map(({ date, isCurrentMonth }) => {
                            const dayOps = getOpsForDate(date);
                            return (
                                <div
                                    key={date.toISOString()}
                                    onClick={() => { setCurrentDate(date); setViewMode('day'); }}
                                    className={`p-1.5 border border-slate-800/50 min-h-[80px] cursor-pointer transition-colors ${
                                        isCurrentMonth ? 'bg-slate-900/40 hover:bg-slate-800/60' : 'bg-slate-950/40 opacity-40'
                                    } ${isToday(date) ? 'ring-1 ring-purple-500/50' : ''}`}
                                >
                                    <span className={`text-xs font-bold ${isToday(date) ? 'bg-purple-500 text-white w-6 h-6 rounded-full flex items-center justify-center shadow-[0_0_8px_rgba(168,85,247,0.5)]' : 'text-slate-400'}`}>
                                        {date.getDate()}
                                    </span>
                                    <div className="mt-1 space-y-0.5 overflow-hidden">
                                        {dayOps.slice(0, 3).map(op => (
                                            <OpBlock key={op.id} op={op} compact viewOperationDetails={viewOperationDetails} formatTime={formatTime} />
                                        ))}
                                        {dayOps.length > 3 && (
                                            <span className="text-[9px] text-slate-500 font-bold">+{dayOps.length - 3} more</span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {viewMode === 'week' && (
                <div className="flex-1 flex flex-col min-h-0">
                    <div className="grid grid-cols-7 gap-3 flex-1">
                        {weekDays.map((date, i) => {
                            const dayOps = getOpsForDate(date);
                            return (
                                <div key={date.toISOString()} className={`flex flex-col rounded-xl border ${isToday(date) ? 'border-purple-500/50 bg-purple-500/5 shadow-lg shadow-purple-900/20' : 'border-slate-700/50 bg-slate-900/60'}`}>
                                    <div className={`text-center py-2 border-b ${isToday(date) ? 'border-purple-500/30' : 'border-slate-700/50'}`}>
                                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{DAYS[i]}</p>
                                        <p className={`text-lg font-black ${isToday(date) ? 'text-purple-300' : 'text-white'}`}>{date.getDate()}</p>
                                    </div>
                                    <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1.5">
                                        {dayOps.map(op => (
                                            <OpBlock key={op.id} op={op} viewOperationDetails={viewOperationDetails} formatTime={formatTime} />
                                        ))}
                                        {dayOps.length === 0 && (
                                            <p className="text-[9px] text-slate-600 text-center italic mt-4">No ops</p>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {viewMode === 'day' && (
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    {dayOps.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 p-10 text-center">
                            <i className="fa-solid fa-calendar-xmark text-4xl text-purple-400 opacity-40 mb-3"></i>
                            <h3 className="text-lg font-bold text-white mb-1">No operations scheduled</h3>
                            <p className="text-sm text-slate-500">Try a different day or create a new operation.</p>
                        </div>
                    ) : (
                            <div className="space-y-3 max-w-3xl">
                                {dayOps.map(op => {
                                    const colors = getTypeColor(op.type);
                                    const activeParticipants = op.participants.filter(p => p.timeLeft === null).length;
                                    const accepted = op.participants.filter(p => p.rsvpStatus === 'Accepted').length;
                                    const tentative = op.participants.filter(p => p.rsvpStatus === 'Tentative').length;
                                    const declined = op.participants.filter(p => p.rsvpStatus === 'Declined').length;
                                    const isConcluded = op.status === OperationStatus.Concluded;
                                    const displayTime = op.scheduledStart || op.activeStartTime;
                                    const isOverdue = op.status === OperationStatus.Scheduled && op.scheduledStart && new Date(op.scheduledStart).getTime() < today.getTime();

                                    return (
                                        <div
                                            key={op.id}
                                            onClick={() => viewOperationDetails(op)}
                                            className={`relative bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-xl p-4 pl-5 cursor-pointer hover:border-purple-500/30 hover:shadow-lg hover:shadow-purple-900/20 hover:-translate-y-0.5 transition-all duration-200 ${isConcluded ? 'opacity-50' : ''}`}
                                        >
                                            <div className={`absolute left-0 top-0 bottom-0 w-1 ${colors.dot}`}></div>
                                            <div className="flex items-start justify-between">
                                                <div>
                                                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                        <div className={`w-2 h-2 rounded-full ${colors.dot} ${op.status === OperationStatus.Active ? 'animate-pulse' : ''}`}></div>
                                                        <span className="text-xs font-mono text-slate-400">
                                                            {displayTime ? formatTime(displayTime) : ''}
                                                            {op.scheduledEnd && ` - ${formatTime(op.scheduledEnd)}`}
                                                        </span>
                                                        <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded border ${
                                                            op.status === OperationStatus.Active ? 'bg-green-500/20 text-green-300 border-green-500/30' :
                                                            op.status === OperationStatus.Planning ? 'bg-purple-500/20 text-purple-300 border-purple-500/30' :
                                                            op.status === OperationStatus.Scheduled ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' :
                                                            'bg-slate-700 text-slate-400 border-slate-600'
                                                        }`}>{op.status}</span>
                                                        <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-sm border ${colors.bg} ${colors.border} ${colors.text}`}>{op.type}</span>
                                                        {isOverdue && (
                                                            <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-sm bg-red-500/20 text-red-400 border border-red-500/30 animate-pulse">
                                                                OVERDUE
                                                            </span>
                                                        )}
                                                    </div>
                                                    <h3 className="text-white text-lg font-bold">{op.name}</h3>
                                                    {op.description && <p className="text-slate-400 text-sm mt-1 line-clamp-2">{op.description}</p>}
                                                </div>
                                                <div className="text-right shrink-0 ml-4 space-y-1">
                                                    <p className="text-xs text-slate-500">
                                                        <i className="fa-solid fa-users mr-1"></i>{activeParticipants} PAX
                                                    </p>
                                                    {(accepted + tentative + declined) > 0 && (
                                                        <div className="flex items-center gap-1.5 text-[9px] font-mono justify-end">
                                                            {accepted > 0 && <span className="text-green-400">{accepted}<i className="fa-solid fa-check ml-0.5"></i></span>}
                                                            {tentative > 0 && <span className="text-amber-400">{tentative}<i className="fa-solid fa-question ml-0.5"></i></span>}
                                                            {declined > 0 && <span className="text-red-400">{declined}<i className="fa-solid fa-xmark ml-0.5"></i></span>}
                                                        </div>
                                                    )}
                                                    {isOverdue && hasPermission('operations:manage') && (
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); updateOperationStatus(op.id, OperationStatus.Active); }}
                                                            className="text-[10px] font-black bg-green-500/10 text-green-400 px-2 py-1 rounded-sm border border-green-500/30 hover:bg-green-500/20 transition-colors uppercase tracking-widest mt-1"
                                                        >
                                                            <i className="fa-solid fa-rocket mr-1"></i>Launch
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                            {op.owner && (
                                                <div className="flex items-center gap-3 mt-3 text-[10px] text-slate-500">
                                                    <span><i className="fa-solid fa-user mr-1"></i>{op.owner.name}</span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                    )}
                </div>
            )}
            </div>
        </div>
    );
};

export default OperationsCalendarView;
