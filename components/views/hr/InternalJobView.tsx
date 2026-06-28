
import React, { useEffect, useState } from 'react';
import UnifiedCaseFileView from './UnifiedCaseFileView';

import { useNavigation } from '../../../contexts/NavigationContext';

const InternalJobView: React.FC = () => {
    const { setActiveView } = useNavigation();
    // Read once at mount via lazy initializer so the value is available during render.
    const [id] = useState<string | null>(() => localStorage.getItem('selected_job_app_id'));

    useEffect(() => {
        if (!id) {
            setActiveView('hr');
        }
    }, [id, setActiveView]);

    if (!id) return null;

    return <UnifiedCaseFileView applicationId={id} onBack={() => setActiveView('hr')} />;
};

export default InternalJobView;
