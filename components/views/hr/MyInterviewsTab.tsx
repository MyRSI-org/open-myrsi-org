
import React, { useEffect, useMemo } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useHR } from '../../../contexts/HRContext';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';

import { HydratedHRInterview } from '../../../types';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

interface InterviewTableProps {
    interviews: (HydratedHRInterview & { applicantName?: string })[];
    fmt: (value: string | null | undefined) => string;
    openEditInterviewModal: (interview: HydratedHRInterview) => void;
    openConductInterviewModal: (interview: HydratedHRInterview) => void;
}

const InterviewTable: React.FC<InterviewTableProps> = ({ interviews, fmt, openEditInterviewModal, openConductInterviewModal }) => (
        <div className="bg-slate-900/60 backdrop-blur-md rounded-xl border border-slate-700/50 overflow-hidden">
            <table className="w-full text-left hidden md:table">
                <thead>
                    <tr className="bg-white/5 border-b border-white/5 text-slate-500 text-[10px] uppercase tracking-widest font-black">
                        <th className="p-4 font-bold">Status</th>
                        <th className="p-4 font-bold">Subject</th>
                        <th className="p-4 font-bold">Protocol</th>
                        <th className="p-4 font-bold">Panel</th>
                        <th className="p-4 font-bold">Date</th>
                        <th className="p-4 font-bold text-right">Actions</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                    {interviews.map(int => (
                        <tr key={int.id} className="hover:bg-slate-700/20 transition-colors">
                            <td className="p-4">
                                <span className={`px-2 py-1 rounded-sm text-[10px] font-black uppercase tracking-wider border ${int.status === 'Completed' ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}>
                                    {int.status}
                                </span>
                                {int.status === 'Completed' && int.isRecommended !== undefined && (
                                    <span className={`ml-1 inline-flex items-center px-1.5 py-0.5 rounded-sm text-[9px] font-black uppercase border ${int.isRecommended ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                                        <i className={`fa-solid ${int.isRecommended ? 'fa-thumbs-up' : 'fa-thumbs-down'}`}></i>
                                    </span>
                                )}
                            </td>
                            <td className="p-4 text-white font-bold">{int.applicantName || 'Unknown Applicant'}</td>
                            <td className="p-4 text-sm text-emerald-300 font-semibold">{int.template.name}</td>
                            <td className="p-4 text-sm text-slate-400">
                                <div className="flex items-center gap-1.5">
                                    <img src={int.interviewer.avatarUrl} className="h-5 w-5 rounded-full border border-slate-700 object-cover shrink-0" alt="" title={`Lead: ${int.interviewer.name}`} />
                                    {int.panelMembers?.slice(0, 3).map(pm => (
                                        <img key={pm.id} src={pm.avatarUrl} className="h-5 w-5 rounded-full border border-slate-700 object-cover shrink-0 -ml-1" alt="" title={pm.name} />
                                    ))}
                                    {(int.panelMembers?.length || 0) > 3 && (
                                        <span className="text-[10px] text-slate-500 font-semibold">+{int.panelMembers.length - 3}</span>
                                    )}
                                </div>
                            </td>
                            <td className="p-4 text-sm text-slate-400 font-mono">{fmt(int.scheduledAt)}</td>
                            <td className="p-4 text-right">
                                <div className="flex justify-end gap-2">
                                    {int.status !== 'Completed' && (
                                        <button
                                            onClick={() => openEditInterviewModal(int)}
                                            className="px-3 py-1.5 bg-amber-500/10 text-amber-300 text-[10px] font-black uppercase tracking-widest rounded-lg border border-amber-500/30 hover:bg-amber-500/20 transition-colors"
                                            title="Edit / Reschedule"
                                        >
                                            <i className="fa-solid fa-pen-to-square mr-1"></i>Edit
                                        </button>
                                    )}
                                    <button
                                        onClick={() => openConductInterviewModal(int)}
                                        className="px-3 py-1.5 bg-emerald-600/10 text-emerald-300 text-[10px] font-black uppercase tracking-widest rounded-lg border border-emerald-500/30 hover:bg-emerald-500/20 transition-colors"
                                    >
                                        {int.status === 'Completed' ? 'View' : 'Start'}
                                    </button>
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {/* Mobile List */}
            <div className="md:hidden flex flex-col divide-y divide-slate-700/50">
                 {interviews.map(int => (
                    <div key={int.id} className="p-4 space-y-3">
                         <div className="flex justify-between items-start">
                            <div>
                                <p className="text-white font-bold">{int.applicantName || 'Unknown Applicant'}</p>
                                <p className="text-xs text-emerald-300 font-semibold mt-0.5">{int.template.name}</p>
                                {int.panelMembers?.length > 0 && (
                                    <div className="flex items-center gap-1 mt-1">
                                        <div className="flex -space-x-1">
                                            {[int.interviewer, ...int.panelMembers].slice(0, 4).map(pm => (
                                                <img key={pm.id} src={pm.avatarUrl} className="h-4 w-4 rounded-full border border-slate-800 object-cover shrink-0" alt="" title={pm.name} />
                                            ))}
                                        </div>
                                        <span className="text-[10px] text-indigo-400 font-semibold">{1 + int.panelMembers.length} members</span>
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-1">
                                {int.status === 'Completed' && int.isRecommended !== undefined && (
                                    <span className={`px-1.5 py-0.5 rounded-sm text-[9px] font-black uppercase border ${int.isRecommended ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                                        <i className={`fa-solid ${int.isRecommended ? 'fa-thumbs-up' : 'fa-thumbs-down'}`}></i>
                                    </span>
                                )}
                                <span className={`px-2 py-1 rounded-sm text-[9px] font-black uppercase tracking-wider border ${int.status === 'Completed' ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}>
                                    {int.status}
                                </span>
                            </div>
                        </div>
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-slate-400 font-mono text-xs">{fmt(int.scheduledAt)}</span>
                            <div className="flex gap-2">
                                {int.status !== 'Completed' && (
                                    <button
                                        onClick={() => openEditInterviewModal(int)}
                                        className="px-3 py-1.5 bg-amber-500/10 text-amber-300 text-[10px] font-black uppercase tracking-widest rounded-lg border border-amber-500/30 hover:bg-amber-500/20 transition-colors"
                                    >
                                        Edit
                                    </button>
                                )}
                                <button
                                    onClick={() => openConductInterviewModal(int)}
                                    className="px-3 py-1.5 bg-emerald-600/10 text-emerald-300 text-[10px] font-black uppercase tracking-widest rounded-lg border border-emerald-500/30 hover:bg-emerald-500/20 transition-colors"
                                >
                                    {int.status === 'Completed' ? 'View' : 'Start'}
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {interviews.length === 0 && (
                 <div className="p-8 text-center text-slate-500 italic">No interviews found.</div>
            )}
        </div>
    );

const MyInterviewsTab: React.FC = () => {
    const { refreshHR } = useData();
    const { hrInterviews } = useHR();
    const { currentUser } = useAuth();
    const fmt = useFormatDate();
    const { openConductInterviewModal, openScheduleInterviewModal, openEditInterviewModal } = useModalRegistry();

    // Ensure we have fresh data
    useEffect(() => {
        refreshHR();
    }, [refreshHR]);

    const myInterviews = useMemo(() => {
        if (!currentUser) return [];
        return hrInterviews
            .filter(int => int.interviewerId === currentUser.id)
            .sort((a, b) => new Date(a.scheduledAt || 0).getTime() - new Date(b.scheduledAt || 0).getTime());
    }, [hrInterviews, currentUser]);

    const upcoming = myInterviews.filter(i => i.status !== 'Completed');
    const past = myInterviews.filter(i => i.status === 'Completed');

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                    <h2 className="text-xl font-black text-white flex items-center gap-3 uppercase tracking-tight">
                        <i className="fa-solid fa-clipboard-user text-emerald-300"></i>
                        My Interviews
                    </h2>
                    <p className="text-slate-400 text-sm mt-1">Upcoming scheduled protocols assigned to you.</p>
                </div>
                <button
                    onClick={() => openScheduleInterviewModal()}
                    className="flex items-center gap-2 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 rounded-lg shadow-lg shadow-emerald-900/30 transition whitespace-nowrap"
                >
                    <i className="fa-solid fa-calendar-plus"></i>Schedule Interview
                </button>
            </div>

            <div className="space-y-3">
                <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest px-1">Upcoming</h3>
                <InterviewTable interviews={upcoming as any} fmt={fmt} openEditInterviewModal={openEditInterviewModal} openConductInterviewModal={openConductInterviewModal} />
            </div>

            <div className="space-y-3">
                <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest px-1">Completed History</h3>
                <InterviewTable interviews={past as any} fmt={fmt} openEditInterviewModal={openEditInterviewModal} openConductInterviewModal={openConductInterviewModal} />
            </div>
        </div>
    );
};

export default MyInterviewsTab;
