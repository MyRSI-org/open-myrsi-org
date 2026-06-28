import React, { useEffect, useState } from 'react';
import { UrgencyLevel } from '../../../../types';
import { ACCENTS } from '../../../shared/ui/accents';
import { slaState } from './requestStyles';

interface Props {
    createdAt: string;
    urgency: UrgencyLevel;
    size?: 'sm' | 'md';
    className?: string;
}

/**
 * Live countdown pill. Accent colour is derived from the SLA bucket:
 * emerald when >50% remaining, amber <50%, red once overdue. Ticks every 30s.
 */
export default function SlaBadge({ createdAt, urgency, size = 'sm', className = '' }: Props) {
    // `tick` only exists to force a re-render; the timer below bumps it so the
    // live SLA countdown re-evaluates every 30s.
    const [tick, setTick] = useState(0);

    useEffect(() => {
        const id = setInterval(() => setTick(t => t + 1), 30_000);
        return () => clearInterval(id);
    }, []);

    const { bucket, label, accent } = slaState(createdAt, urgency);
    const a = ACCENTS[accent];
    const sizeCls = size === 'md' ? 'px-2.5 py-1 text-[11px]' : 'px-2 py-0.5 text-[10px]';

    return (
        <span
            title={`SLA target based on ${urgency} urgency`}
            className={`inline-flex items-center gap-1.5 rounded-sm border font-mono font-bold uppercase tracking-wider ${sizeCls} ${a.bg} ${a.border} ${a.text} ${bucket === 'overdue' ? 'animate-pulse' : ''} ${className}`}
        >
            <i className={`fa-solid ${bucket === 'overdue' ? 'fa-triangle-exclamation' : 'fa-clock'}`} aria-hidden />
            {label}
        </span>
    );
}
