
import React, { useEffect, useState } from 'react';
import UnifiedCaseFileView from './UnifiedCaseFileView';

import { useNavigation } from '../../../contexts/NavigationContext';

const ApplicantDetailView: React.FC = () => {
    const { setActiveView } = useNavigation();
    // Fallback to legacy local storage method if no selectedCaseFile in context.
    // Read once at mount via lazy initializer so the value is available during render.
    const [id] = useState<string | null>(() => localStorage.getItem('selected_applicant_id'));

    useEffect(() => {
        if (!id) {
            setActiveView('hr');
        }
    }, [id, setActiveView]);

    if (!id) return null;

    return <UnifiedCaseFileView applicationId={id} onBack={() => setActiveView('hr')} />;
};

export default ApplicantDetailView;
