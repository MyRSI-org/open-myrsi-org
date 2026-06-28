// HRContext owns the HR slices (applicants, interviews, jobs, templates,
// transfers, positions).
//
// Mounts OUTSIDE DataProvider so DataContext can call useHR() inside its body
// and re-expose the HR fields on its own context value, keeping the useData()
// surface unchanged.
//
// There are no local HR CRUD methods; HR mutations come through other action
// paths. refreshHR is defined in DataContext and registered here via
// registerRefreshHR so future CRUD can chain a post-RPC refresh without
// depending on useData() (which would create a context cycle).
//
// Hydration: registers a single slice setter under key 'hr' that handles all
// six fields when data.hr is present (the server payload nests HR fields under
// an `hr` object).
//
// DataContext's optimisticUpdate has 'hr_applications'/'hr_interviews' branches
// that write through setHrApplicants/setHrInterviews exposed here; setHrJobs is
// likewise forwarded on the useData() value per DataContextType.

import React, { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataCore } from './DataCoreContext';
import {
    HydratedHRApplication, HydratedHRInterview, JobPosting,
    HRInterviewTemplate, TransferRequest, PersonnelPosition,
} from '../types';

// Re-exports so domain consumers can import either from '../contexts/HRContext'
// or '../types/hr' interchangeably.
export type {
    HydratedHRApplication,
    HydratedHRInterview,
    JobPosting,
    HRInterviewTemplate,
    TransferRequest,
    PersonnelPosition,
} from '../types';

export interface HRContextValue {
    hrApplicants: HydratedHRApplication[];
    hrInterviews: HydratedHRInterview[];
    hrJobs: JobPosting[];
    hrTemplates: HRInterviewTemplate[];
    hrTransfers: TransferRequest[];
    hrPositions: PersonnelPosition[];

    // Exposed for DataContext's optimisticUpdate ('hr_applications',
    // 'hr_interviews') branches and the setHrJobs forward on the useData() value.
    setHrApplicants: React.Dispatch<React.SetStateAction<HydratedHRApplication[]>>;
    setHrInterviews: React.Dispatch<React.SetStateAction<HydratedHRInterview[]>>;
    setHrJobs: React.Dispatch<React.SetStateAction<JobPosting[]>>;
    setHrTemplates: React.Dispatch<React.SetStateAction<HRInterviewTemplate[]>>;
    setHrTransfers: React.Dispatch<React.SetStateAction<TransferRequest[]>>;
    setHrPositions: React.Dispatch<React.SetStateAction<PersonnelPosition[]>>;

    refreshHR: () => Promise<void> | void;

    /** DataContext registers its refreshHR callback here once defined, so
     *  future HR-owned CRUD can chain a post-RPC refresh. */
    registerRefreshHR: (fn: () => Promise<void> | void) => () => void;
}

const HRContext = createContext<HRContextValue | null>(null);

export const HRProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { registerSliceSetter } = useDataCore();

    const [hrApplicants, setHrApplicants] = useState<HydratedHRApplication[]>([]);
    const [hrInterviews, setHrInterviews] = useState<HydratedHRInterview[]>([]);
    const [hrJobs, setHrJobs] = useState<JobPosting[]>([]);
    const [hrTemplates, setHrTemplates] = useState<HRInterviewTemplate[]>([]);
    const [hrTransfers, setHrTransfers] = useState<TransferRequest[]>([]);
    const [hrPositions, setHrPositions] = useState<PersonnelPosition[]>([]);

    // DataContext registers refreshHR here on mount; held in a ref so future
    // CRUD can call it without re-creating callbacks on every render.
    const refreshHRRef = useRef<(() => Promise<void> | void) | null>(null);

    const registerRefreshHR = useCallback((fn: () => Promise<void> | void) => {
        refreshHRRef.current = fn;
        return () => {
            if (refreshHRRef.current === fn) refreshHRRef.current = null;
        };
    }, []);

    const refreshHR = useCallback(async () => {
        const fn = refreshHRRef.current;
        if (fn) await fn();
    }, []);

    // Single slice setter under key 'hr' handling all six fields when data.hr
    // is present — matches the server payload shape (HR fields nested under hr).
    useEffect(() => {
        const unreg = registerSliceSetter('hr', (data: any) => {
            if (data.hr) {
                if (data.hr.applicants) setHrApplicants(data.hr.applicants);
                if (data.hr.interviews) setHrInterviews(data.hr.interviews);
                if (data.hr.jobs) setHrJobs(data.hr.jobs);
                if (data.hr.templates) setHrTemplates(data.hr.templates);
                if (data.hr.transfers) setHrTransfers(data.hr.transfers);
                if (data.hr.positions) setHrPositions(data.hr.positions);
            }
        });
        return unreg;
    }, [registerSliceSetter]);

    const value = useMemo<HRContextValue>(() => ({
        hrApplicants, hrInterviews, hrJobs, hrTemplates, hrTransfers, hrPositions,
        setHrApplicants, setHrInterviews, setHrJobs,
        setHrTemplates, setHrTransfers, setHrPositions,
        refreshHR,
        registerRefreshHR,
    }), [
        hrApplicants, hrInterviews, hrJobs, hrTemplates, hrTransfers, hrPositions,
        refreshHR,
        registerRefreshHR,
    ]);

    return <HRContext value={value}>{children}</HRContext>;
};

export const useHR = (): HRContextValue => {
    const ctx = use(HRContext);
    if (!ctx) throw new Error('useHR must be used within an HRProvider');
    return ctx;
};
