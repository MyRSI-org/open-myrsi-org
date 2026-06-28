
import React from 'react';
import { useHR } from '../../../contexts/HRContext';
import { JobPostingStatus } from '../../../types';
import EmptyState from '../../shared/ui/EmptyState';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

const GazetteTab: React.FC = () => {
    const { hrJobs } = useHR();
    const { openApplyJobModal } = useModalRegistry();

    const openJobs = hrJobs.filter(j => j.status === JobPostingStatus.Open);

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-xl font-black text-white flex items-center gap-3 uppercase tracking-tight">
                        <i className="fa-solid fa-newspaper text-emerald-300"></i>
                        Job Gazette
                    </h2>
                    <p className="text-slate-400 text-sm mt-1">Internal opportunities and vacancies. {openJobs.length > 0 && <span className="text-emerald-300 font-mono">{openJobs.length} open</span>}</p>
                </div>
            </div>
            {openJobs.length > 0 ? (
                <div className="grid grid-cols-1 gap-4">
                    {openJobs.map(job => (
                        <div key={job.id} className="relative bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-xl p-5 pl-6 hover:border-emerald-500/30 hover:shadow-lg hover:shadow-emerald-900/20 hover:-translate-y-0.5 transition-all duration-300 group">
                            <div className="absolute left-0 top-0 bottom-0 w-1 bg-emerald-500 rounded-l-xl"></div>
                            <div className="flex flex-col md:flex-row justify-between items-start gap-4 mb-4">
                                <div className="min-w-0">
                                    <span className="text-[10px] font-black text-emerald-300 uppercase tracking-widest bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-sm mb-2 inline-block">{job.department}</span>
                                    <h3 className="text-xl font-black text-white group-hover:text-emerald-200 transition-colors">{job.title}</h3>
                                </div>
                                <button
                                    onClick={() => openApplyJobModal(job)}
                                    className="flex items-center gap-2 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 rounded-lg shadow-lg shadow-emerald-900/30 transition whitespace-nowrap"
                                >
                                    <i className="fa-solid fa-pen-to-square"></i> Apply Now
                                </button>
                            </div>
                            <p className="text-sm text-slate-300 leading-relaxed mb-4 bg-slate-950/40 p-4 rounded-lg border border-slate-700/50">{job.description}</p>
                            <div className="flex flex-wrap gap-2">
                                {job.requirements.map((req) => (
                                    <span key={req} className="inline-flex items-center gap-1.5 text-[10px] bg-slate-900/60 px-3 py-1.5 rounded-full border border-slate-700 text-slate-400 font-mono">
                                        <i className="fa-solid fa-check text-green-400"></i>{req}
                                    </span>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30">
                    <EmptyState
                        icon="fa-newspaper"
                        accent="emerald"
                        heading="No open positions"
                        description="Check back later — new opportunities are posted as command needs emerge."
                    />
                </div>
            )}
        </div>
    );
};

export default GazetteTab;
