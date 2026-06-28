import React from 'react';
import {
    HydratedHRApplication,
    HydratedHRInterview,
    JobPosting,
    ApplicationStatus,
    JobPostingStatus,
} from '../../../../../types';
import { AccentKey } from '../../../../shared/ui/accents';
import SearchResultCard from '../SearchResultCard';
import { timeAgoShort } from '../../../intel/intelStyles';

type HrSubtype = 'application' | 'interview' | 'posting';

interface Props {
    subtype: HrSubtype;
    data: HydratedHRApplication | HydratedHRInterview | JobPosting;
    onClick: () => void;
    isSelected?: boolean;
}

const subtypeLabel: Record<HrSubtype, string> = {
    application: 'Application',
    interview: 'Interview',
    posting: 'Posting',
};

const subtypeIcon: Record<HrSubtype, string> = {
    application: 'fa-id-card',
    interview: 'fa-comments',
    posting: 'fa-briefcase',
};

const applicationAccent = (status: ApplicationStatus): AccentKey => {
    switch (status) {
        case ApplicationStatus.Applied:
        case ApplicationStatus.Screening:
            return 'sky';
        case ApplicationStatus.Interviewing:
        case ApplicationStatus.OnHold:
            return 'amber';
        case ApplicationStatus.Offered:
        case ApplicationStatus.Accepted:
        case ApplicationStatus.Hired:
            return 'emerald';
        case ApplicationStatus.Rejected:
        case ApplicationStatus.Withdrawn:
            return 'slate';
        default:
            return 'amber';
    }
};

const postingAccent = (status: JobPostingStatus): AccentKey => {
    switch (status) {
        case JobPostingStatus.Open: return 'emerald';
        case JobPostingStatus.Draft: return 'slate';
        case JobPostingStatus.Closed: return 'slate';
        case JobPostingStatus.Filled: return 'sky';
        default: return 'amber';
    }
};

const HrRowContent: React.FC<Props> = ({ subtype, data, onClick, isSelected }) => {
    let accent: AccentKey;
    let title: string;
    let timestamp: string;
    let summary: string;
    let statusLabel: string;
    let statusAccentClasses = 'bg-slate-900/60 border-white/10 text-slate-400';

    if (subtype === 'application') {
        const a = data as HydratedHRApplication;
        accent = applicationAccent(a.status);
        title = a.applicantName || a.rsiHandle;
        timestamp = a.createdAt;
        summary = a.referralSource ? `Source: ${a.referralSource}` : (a.notes || a.rsiHandle);
        statusLabel = a.status;
        if (accent === 'emerald') statusAccentClasses = 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300';
        else if (accent === 'amber') statusAccentClasses = 'bg-amber-500/10 border-amber-500/30 text-amber-300';
        else if (accent === 'sky') statusAccentClasses = 'bg-sky-500/10 border-sky-500/30 text-sky-300';
    } else if (subtype === 'interview') {
        const i = data as HydratedHRInterview;
        accent = 'amber';
        title = i.applicantName || `Interview #${i.id.slice(0, 6)}`;
        timestamp = i.scheduledAt;
        summary = `${i.template?.name || 'Interview'} · ${i.interviewer?.name || 'TBD'}`;
        statusLabel = i.status;
        statusAccentClasses = 'bg-amber-500/10 border-amber-500/30 text-amber-300';
    } else {
        const j = data as JobPosting;
        accent = postingAccent(j.status);
        title = j.title;
        timestamp = j.createdAt;
        summary = j.department || j.description?.slice(0, 80) || '';
        statusLabel = j.status;
        if (accent === 'emerald') statusAccentClasses = 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300';
        else if (accent === 'sky') statusAccentClasses = 'bg-sky-500/10 border-sky-500/30 text-sky-300';
    }

    return (
        <SearchResultCard
            accent={accent}
            icon={subtypeIcon[subtype]}
            onClick={onClick}
            isSelected={isSelected}
        >
            <div className="flex items-center gap-2 min-w-0">
                <span className="px-1.5 py-0.5 rounded-sm border bg-amber-500/10 border-amber-500/30 text-amber-300 font-black text-[9px] uppercase tracking-widest shrink-0">
                    HR · {subtypeLabel[subtype]}
                </span>
                <h3 className="text-white font-bold text-sm truncate">{title}</h3>
                {timestamp && (
                    <>
                        <span className="text-slate-700 shrink-0">·</span>
                        <span className="text-[10px] text-slate-500 font-mono whitespace-nowrap">
                            <i className="fa-regular fa-clock mr-1" aria-hidden />
                            {timeAgoShort(timestamp)}
                        </span>
                    </>
                )}
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
                <p className="text-[11px] text-slate-300 truncate min-w-0 flex-1">
                    {summary}
                </p>
                {statusLabel && (
                    <span className={`px-1.5 py-0.5 rounded-sm border font-black text-[9px] uppercase tracking-widest shrink-0 ${statusAccentClasses}`}>
                        {statusLabel}
                    </span>
                )}
            </div>
        </SearchResultCard>
    );
};

export default React.memo(HrRowContent);
