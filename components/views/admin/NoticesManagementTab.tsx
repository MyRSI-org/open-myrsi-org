
import React, { useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useFormatDate } from '../../../contexts/AuthContext';
import { useAnnouncements } from '../../../contexts/AnnouncementsContext';

import { Announcement, AnnouncementType } from '../../../types';
import { useTableControls } from '../../../hooks/useTableControls';
import { TabPageHeader } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

const AUDIENCE_LABELS: Record<string, string> = {
    'Client': 'Client Dashboard',
    'Member': 'Members Dashboard',
    'Admin': 'Admins Only',
    'Login Screen': 'Login Screen',
    'Dispatcher': 'Dispatcher',
};

const getTypeStyles = (type: AnnouncementType) => {
    switch (type) {
        case AnnouncementType.Danger: return { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/20', icon: 'fa-triangle-exclamation' };
        case AnnouncementType.Warning: return { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/20', icon: 'fa-circle-exclamation' };
        case AnnouncementType.Information:
        default: return { bg: 'bg-sky-500/10', text: 'text-sky-400', border: 'border-sky-500/20', icon: 'fa-circle-info' };
    }
}

const NoticesManagementTab: React.FC = () => {
    const { announcements, isFetching } = useData();
    const { deleteAnnouncement } = useAnnouncements();
    const fmt = useFormatDate();
    const { confirm } = useNotification();
    const { openNoticeModal } = useModalRegistry();
    const [searchTerm, setSearchTerm] = useState('');

    const { sortedAndFilteredItems } = useTableControls(
        announcements,
        { key: 'publishDate', direction: 'descending' },
        ['title', 'type', 'audience', 'body'],
        searchTerm
    );

    const handleDelete = async (notice: Announcement) => {
        if (await confirm({ title: 'Delete Notice', message: `Are you sure you want to delete the notice "${notice.title}"?`, confirmText: 'Delete', variant: 'danger' })) {
            deleteAnnouncement(notice.id);
        }
    };

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="Notices & Alerts"
                icon="fa-solid fa-bullhorn"
                accent="orange"
                subtitle="Manage system-wide broadcasts and information."
                meta={isFetching['announcements'] && (
                    <span className="text-slate-300 animate-pulse text-xs font-bold flex items-center gap-1">
                        <i className="fa-solid fa-arrows-rotate fa-spin"></i> Syncing...
                    </span>
                )}
                actions={
                    <div className="flex gap-2 w-full md:w-auto">
                        <div className="relative flex-1 md:w-64">
                            <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                            <input
                                type="text"
                                placeholder="Search notices..."
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="w-full bg-slate-900/60 border border-slate-700 rounded-lg py-2.5 pl-10 pr-4 text-white placeholder:text-slate-500 focus:ring-1 focus:ring-slate-400/50 focus:border-slate-500 outline-hidden text-sm font-medium transition-all"
                            />
                        </div>
                        <button
                            onClick={() => openNoticeModal()}
                            className="flex items-center justify-center bg-slate-700 text-white font-bold px-4 py-2.5 rounded-lg border border-slate-600 hover:bg-slate-600 transition-colors shadow-lg text-sm whitespace-nowrap"
                        >
                            <i className="fa-solid fa-plus mr-2" />
                            Create Notice
                        </button>
                    </div>
                }
            />

            <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 overflow-hidden">
                <div className="flex bg-slate-800/60 p-4 border-b border-slate-700/50 text-xs font-black text-slate-500 uppercase tracking-widest">
                    <div className="flex-1">Announcement Details</div>
                    <div className="w-48 hidden md:block">Audience</div>
                    <div className="w-32 hidden sm:block text-right">Expires</div>
                    <div className="w-24 text-right">Actions</div>
                </div>

                <div className="divide-y divide-slate-700/50">
                    {sortedAndFilteredItems.map(notice => {
                        const styles = getTypeStyles(notice.type);
                        return (
                            <div key={notice.id} className="flex items-center p-4 hover:bg-slate-800/50 transition-colors group">
                                <div className="flex-1 min-w-0 pr-4">
                                    <div className="flex items-center gap-3 mb-1">
                                        <div className={`w-6 h-6 rounded-sm flex items-center justify-center ${styles.bg} ${styles.text} border ${styles.border}`}>
                                            <i className={`fa-solid ${styles.icon} text-xs`}></i>
                                        </div>
                                        <h3 className="text-white font-bold text-sm truncate">{notice.title}</h3>
                                        <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded-sm border ${styles.bg} ${styles.text} ${styles.border}`}>
                                            {notice.type}
                                        </span>
                                    </div>
                                    <p className="text-slate-400 text-xs line-clamp-1 pl-9">{notice.body}</p>
                                </div>

                                <div className="w-48 hidden md:flex flex-wrap gap-1">
                                    {notice.audience.slice(0, 3).map((aud) => (
                                        <span key={aud} className="text-[9px] bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded-sm border border-slate-700 uppercase font-bold">
                                            {AUDIENCE_LABELS[aud] || aud}
                                        </span>
                                    ))}
                                    {notice.audience.length > 3 && (
                                        <span className="text-[9px] text-slate-500 px-1 py-0.5">+{notice.audience.length - 3}</span>
                                    )}
                                </div>

                                <div className="w-32 hidden sm:block text-right">
                                    <span className={`text-xs font-mono ${notice.expiryDate ? 'text-slate-400' : 'text-slate-600 italic'}`}>
                                        {notice.expiryDate ? fmt(notice.expiryDate) : 'Never'}
                                    </span>
                                </div>

                                <div className="w-24 text-right flex justify-end gap-2">
                                    <button onClick={() => openNoticeModal(notice)} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-sm transition-colors" title="Edit">
                                        <i className="fa-solid fa-pencil"></i>
                                    </button>
                                    <button onClick={() => handleDelete(notice)} className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-900/20 rounded-sm transition-colors" title="Delete">
                                        <i className="fa-solid fa-trash-can"></i>
                                    </button>
                                </div>
                            </div>
                        );
                    })}

                    {sortedAndFilteredItems.length === 0 && (
                        <div className="p-12 text-center">
                            <p className="text-slate-500 font-medium italic">No notices match your criteria.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default NoticesManagementTab;
