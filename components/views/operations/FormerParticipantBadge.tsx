import React from 'react';
import { FORMER_PARTICIPANT_LABEL, FORMER_PARTICIPANT_TITLE } from './participantRoster';

/**
 * The marker beside a FORMER participant (a row stamped when the op concluded) in a
 * rendered roster list. One component so every list marks them the same way. Only
 * ever rendered by display/read lists — action controls never offer former rows.
 */
const FormerParticipantBadge: React.FC = () => (
    <span
        title={FORMER_PARTICIPANT_TITLE}
        className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm border bg-slate-800/60 text-slate-400 border-slate-600/50 shrink-0"
    >
        {FORMER_PARTICIPANT_LABEL}
    </span>
);

export default FormerParticipantBadge;
