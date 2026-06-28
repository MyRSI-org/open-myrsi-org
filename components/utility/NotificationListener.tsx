import React, { useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useData } from '../../contexts/DataContext';
import { useConfig } from '../../contexts/ConfigContext';
import { UserRole } from '../../types';
import { useNotification } from '../../contexts/NotificationContext';
import { debugLog } from '../../lib/debugLog';

// Architectural note: this component used to subscribe directly to the org
// realtime channel (`db-changes-{orgId}`) for its broadcast handlers. That
// collided with DataContext, which also owns that channel — supabase-js
// singleton-shares channel objects by name, and adding `.on()` to an
// already-`.subscribe()`d channel throws "cannot add callbacks ... after
// subscribe()". Broadcast events are therefore now received via window
// CustomEvents that DataContext re-emits. Only the postgres_changes
// listener (filter-routed, channel-name-agnostic) needs its own channel,
// kept under a tab-unique name to stay clear of DataContext's channel.
const NotificationListener: React.FC = () => {
    const { currentUser } = useAuth();
    const { hydratedServiceRequests } = useData();
    const { brandingConfig } = useConfig();
    const { addToast, playSound } = useNotification();

    // Use refs to avoid stale closure issues
    const currentUserRef = useRef(currentUser);
    const addToastRef = useRef(addToast);
    const playSoundRef = useRef(playSound);
    const brandingConfigRef = useRef(brandingConfig);
    const hydratedRequestsRef = useRef(hydratedServiceRequests);

    useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);
    useEffect(() => { addToastRef.current = addToast; }, [addToast]);
    useEffect(() => { playSoundRef.current = playSound; }, [playSound]);
    useEffect(() => { brandingConfigRef.current = brandingConfig; }, [brandingConfig]);
    useEffect(() => { hydratedRequestsRef.current = hydratedServiceRequests; }, [hydratedServiceRequests]);

    // --- Window-event listeners for DataContext-relayed broadcasts ---
    useEffect(() => {
        if (!currentUser?.id) return;

        const user0 = currentUserRef.current;
        const roleValue = String(user0?.role);
        const isStaff = roleValue === UserRole.Member ||
            roleValue === UserRole.Dispatcher ||
            roleValue === UserRole.Admin;

        debugLog("NotificationListener: Initializing for", user0?.name, "isStaff:", isStaff);

        const onNewRequest = (e: Event) => {
            const newRequest = (e as CustomEvent).detail;
            const user = currentUserRef.current;
            const toast = addToastRef.current;
            const sound = playSoundRef.current;
            const config = brandingConfigRef.current;

            debugLog("NotificationListener: new_request event received", {
                newRequest,
                isStaff,
                userId: user?.id,
                clientId: newRequest?.clientId || newRequest?.client_id
            });

            // Staff receive notifications (but not if they created it).
            // Generic title: the broadcast is id-only (serviceType was an
            // activity-describing label and no longer rides the wire) — the
            // request card itself arrives via the permission-scoped refetch.
            const requestClientId = newRequest?.clientId || newRequest?.client_id;
            if (isStaff && user && requestClientId !== user.id) {
                debugLog("NotificationListener: SHOWING TOAST for staff new request");
                toast(
                    'New Priority Request',
                    <i className="fa-solid fa-satellite-dish"></i>,
                    'bg-sky-600 text-white shadow-sky-900/50',
                    { requestId: newRequest?.id, silent: true }
                );
                if (config?.newRequestSoundUrl) sound(config.newRequestSoundUrl);
            }
        };

        const onBulletinUpdate = (e: Event) => {
            const bulletinData = (e as CustomEvent).detail;
            const user = currentUserRef.current;
            const toast = addToastRef.current;
            const sound = playSoundRef.current;
            const config = brandingConfigRef.current;

            // The broadcast carries only { type, bulletinId, createdById } — no
            // body/title/threatLevel, since the threat classification is itself
            // clearance-gated content. The toast is generic and gated on
            // intel:view so members without intel access don't learn intel
            // activity occurred; the clearance-filtered bulletin arrives via the
            // gated bulletin_slice refetch.
            if (bulletinData?.type === 'new_bulletin') {
                if (!user?.permissions?.includes('intel:view') && String(user?.role) !== UserRole.Admin) return;
                const createdById = bulletinData.createdById ?? bulletinData.bulletin?.created_by_id;
                // Skip if current user is the author
                if (user && createdById === user.id) return;

                toast(
                    `New Intel Bulletin`,
                    <i className="fa-solid fa-satellite-dish"></i>,
                    'bg-sky-600 text-white',
                    { silent: true }
                );
                if (config?.newRequestSoundUrl) sound(config.newRequestSoundUrl);
            }
        };

        const onRequestUpdate = (e: Event) => {
            const updatedRequest = (e as CustomEvent).detail;
            const user = currentUserRef.current;
            const toast = addToastRef.current;
            const sound = playSoundRef.current;
            const config = brandingConfigRef.current;

            const requestClientId = updatedRequest?.clientId || updatedRequest?.client_id;

            debugLog("NotificationListener: request_update event received", {
                status: updatedRequest?.status,
                clientId: requestClientId,
                userId: user?.id
            });

            // Notify the client who owns this request
            if (user && requestClientId === user.id) {
                const statusColors: Record<string, string> = {
                    'Accepted': 'bg-green-500/10 text-green-400 border-green-500/50',
                    'In-Progress': 'bg-blue-500/10 text-blue-400 border-blue-500/50',
                    'Success': 'bg-green-500/10 text-green-400 border-green-500/50',
                    'Failed': 'bg-red-500/10 text-red-400 border-red-500/50',
                    'Cancelled': 'bg-red-500/10 text-red-400 border-red-500/50',
                    'Refused': 'bg-red-500/10 text-red-400 border-red-500/50',
                };

                if (statusColors[updatedRequest?.status]) {
                    debugLog("NotificationListener: SHOWING TOAST for client status update");
                    toast(
                        `Mission Status: ${updatedRequest.status}`,
                        <i className="fa-solid fa-satellite-dish"></i>,
                        statusColors[updatedRequest.status],
                        { requestId: updatedRequest?.id, silent: true }
                    );
                    if (config?.assignmentSoundUrl) sound(config.assignmentSoundUrl);
                }
            }
        };

        window.addEventListener('app:realtime:new-request', onNewRequest);
        window.addEventListener('app:realtime:bulletin-update', onBulletinUpdate);
        window.addEventListener('app:realtime:request-update', onRequestUpdate);

        return () => {
            window.removeEventListener('app:realtime:new-request', onNewRequest);
            window.removeEventListener('app:realtime:bulletin-update', onBulletinUpdate);
            window.removeEventListener('app:realtime:request-update', onRequestUpdate);
        };
    }, [currentUser?.id]);

    // Responder change awareness for the request's client and for peer staff
    // already on the request. Self-assignment toasts live in AuthContext; here
    // we only fire when the affected user is someone *else*.
    //
    // Previously a postgres_changes INSERT listener on `request_responders`,
    // which silently broke when add-user-presence.sql dropped the junction
    // table from the supabase_realtime publication. Now driven by the
    // `responder_change` broadcast relayed by DataContext as a window event —
    // no extra channel subscription needed.
    useEffect(() => {
        if (!currentUser?.id) return;

        const onResponderChange = (e: Event) => {
            const detail = (e as CustomEvent).detail as { requestId?: string; userId?: number; action?: 'assigned' | 'unassigned' } | undefined;
            if (!detail || !detail.requestId || detail.action === undefined) return;

            const user = currentUserRef.current;
            const toast = addToastRef.current;
            const sound = playSoundRef.current;
            const config = brandingConfigRef.current;
            const requests = hydratedRequestsRef.current;

            if (!user || detail.userId === user.id) return; // self-toast lives in AuthContext

            const matchingRequest = requests.find((r: any) => r.id === detail.requestId);
            if (!matchingRequest) return;

            const isClient = matchingRequest.clientId === user.id;
            const isPeerStaff = !isClient && matchingRequest.assignedMemberIds?.includes(user.id);
            if (!isClient && !isPeerStaff) return;

            if (detail.action === 'assigned') {
                if (isClient) {
                    toast(`Responder assigned to your request`, <i className="fa-solid fa-user-plus"></i>, 'bg-sky-500/10 text-sky-400 border-sky-500/50', { requestId: detail.requestId, silent: true });
                } else {
                    toast(`New responder added to your mission`, <i className="fa-solid fa-user-plus"></i>, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50', { requestId: detail.requestId, silent: true });
                }
                if (config?.assignmentSoundUrl) sound(config.assignmentSoundUrl);
            } else if (detail.action === 'unassigned') {
                if (isClient) {
                    toast(`Responder removed from your request`, <i className="fa-solid fa-user-minus"></i>, 'bg-amber-500/10 text-amber-400 border-amber-500/50', { requestId: detail.requestId, silent: true });
                } else {
                    toast(`Teammate removed from your mission`, <i className="fa-solid fa-user-minus"></i>, 'bg-amber-500/10 text-amber-400 border-amber-500/50', { requestId: detail.requestId, silent: true });
                }
                if (config?.assignmentSoundUrl) sound(config.assignmentSoundUrl);
            }
        };

        window.addEventListener('app:realtime:responder-change', onResponderChange);
        return () => window.removeEventListener('app:realtime:responder-change', onResponderChange);
    }, [currentUser?.id]);

    return null;
};

export default NotificationListener;
