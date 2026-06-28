



import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useOperations } from '../../../contexts/OperationsContext';
import { UnitPost, OrganizationalUnit } from '../../../types';
import { getSupabase } from '../../../lib/supabaseClient';
import EmptyState from '../../shared/ui/EmptyState';
import { useNotification } from '../../../contexts/NotificationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

// Helper for feed media embedding
const MediaEmbed: React.FC<{ url: string }> = ({ url }) => {
    const isImage = /\.(jpeg|jpg|gif|png|webp)$/i.test(url);
    const isVideo = /\.(mp4|webm)$/i.test(url) || url.includes('youtube.com') || url.includes('youtu.be');

    if (isImage) return <img src={url} alt="Attachment" className="max-h-60 rounded-lg border border-slate-700 mt-2" loading="lazy" />;
    if (isVideo) {
        if (url.includes('youtube') || url.includes('youtu.be')) {
            const videoId = url.split('v=')[1] || url.split('/').pop();
            return (
                <iframe
                    src={`https://www.youtube.com/embed/${videoId}`}
                    className="w-full aspect-video rounded-lg border border-slate-700 mt-2"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                />
            );
        }
        return <video src={url} controls className="max-h-60 rounded-lg border border-slate-700 mt-2" />;
    }
    return <a href={url} target="_blank" rel="noopener noreferrer" className="text-emerald-300 hover:underline block mt-1 text-xs truncate">{url}</a>;
};

const UnitFeed: React.FC<{ unitId: number }> = ({ unitId }) => {
    const { rpcAction } = useData();
    const { currentUser } = useAuth();
    const fmt = useFormatDate();
    const { addToast, confirm: confirmDialog } = useNotification();
    const [posts, setPosts] = useState<UnitPost[]>([]);
    const [content, setContent] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isPosting, setIsPosting] = useState(false);

    const fetchFeed = useCallback(async () => {
        try {
            const data = await rpcAction('unit:get_feed', { unitId });
            setPosts(data || []);
        } catch (e) { console.error(e); } finally { setIsLoading(false); }
    }, [unitId, rpcAction]);

    useEffect(() => {
        // Mount-time feed fetch (state is set after the awaited RPC, not derived
        // from props/state) plus the realtime subscription that re-fetches on
        // unit_posts changes. Both are external-system synchronization. The fetch
        // is wrapped in an async IIFE so the deferred (post-await) setState is
        // explicit — this is the documented React async-effect pattern.
        void (async () => { await fetchFeed(); })();

        const supabase = getSupabase();
        if (!supabase) return;

        const channel = supabase.channel(`unit_posts:${unitId}`)
            .on('postgres_changes',
                { event: '*', schema: 'public', table: 'unit_posts', filter: `unit_id=eq.${unitId}` },
                () => fetchFeed()
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [fetchFeed, unitId]);

    const handlePost = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!content.trim()) return;
        setIsPosting(true);
        try {
            await rpcAction('unit:create_post', { unitId, userId: currentUser?.id, content });
            setContent('');
            fetchFeed();
        } catch { addToast("Post Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to publish your post." }); } finally { setIsPosting(false); }
    };

    const handleDelete = async (postId: string) => {
        const confirmed = await confirmDialog({ title: 'Delete Post', message: 'Delete post?', confirmText: 'Delete', variant: 'danger' });
        if (!confirmed) return;
        try {
            await rpcAction('unit:delete_post', { postId });
            fetchFeed();
        } catch { addToast("Delete Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to delete the post." }); }
    };

    return (
        <div className="flex flex-col h-[600px] bg-slate-900/60 backdrop-blur-md rounded-xl border border-slate-700/50 overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5 bg-white/5 flex items-center gap-3 shrink-0">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-300">
                    <i className="fa-solid fa-comments text-sm"></i>
                </div>
                <h3 className="font-bold text-white text-sm uppercase tracking-wider">Unit Comms</h3>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                {isLoading ? (
                    <div className="text-center text-slate-500 italic py-10">Loading feed...</div>
                ) : posts.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                        <EmptyState icon="fa-comment-slash" accent="emerald" heading="No messages yet" description="Be the first to post." compact />
                    </div>
                ) : (
                    posts.map(post => {
                        const urls = post.content.match(/(https?:\/\/[^\s]+)/g);
                        const text = post.content.replace(/(https?:\/\/[^\s]+)/g, '');
                        const isAuthor = post.authorId === currentUser?.id;
                        // Mint a stable, content-derived key per URL occurrence. post.content is
                        // immutable and the embed list never reorders, so post id + URL + a
                        // per-URL occurrence counter is unique even when a URL repeats — no need
                        // for the bare array index as the React key.
                        const seenUrlCounts: Record<string, number> = {};
                        const embeds = (urls || []).map(url => {
                            const n = seenUrlCounts[url] = (seenUrlCounts[url] || 0) + 1;
                            return { key: `${post.id}:${url}:${n}`, url };
                        });

                        return (
                            <div key={post.id} className={`flex gap-3 group ${isAuthor ? 'flex-row-reverse' : ''}`}>
                                <img src={post.author?.avatarUrl} className="w-8 h-8 rounded-full border border-slate-700 object-cover shrink-0" />
                                <div className={`max-w-[80%] rounded-2xl p-3 text-sm ${isAuthor ? 'bg-emerald-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700/50'}`}>
                                    <div className={`flex justify-between items-center gap-4 mb-1 text-[10px] opacity-70 ${isAuthor ? 'flex-row-reverse' : ''}`}>
                                        <span className={`font-bold ${isAuthor ? 'text-emerald-100' : 'text-slate-400'}`}>{post.author?.name}</span>
                                        <span className={isAuthor ? 'text-emerald-100' : 'text-slate-500'}>{fmt.time(post.createdAt)}</span>
                                    </div>
                                    <p className="whitespace-pre-wrap leading-relaxed">{text}</p>
                                    {embeds.map(({ key, url }) => <MediaEmbed key={key} url={url} />)}
                                    {isAuthor && (
                                        <button
                                            onClick={() => handleDelete(post.id)}
                                            className="opacity-0 group-hover:opacity-100 text-[10px] text-red-300 hover:text-red-200 mt-2 transition-opacity block ml-auto"
                                        >
                                            Delete
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            <form onSubmit={handlePost} className="p-3 border-t border-white/5 bg-slate-950/40 flex gap-2 shrink-0">
                <input
                    type="text"
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    placeholder="Message unit..."
                    className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/30 outline-hidden transition-all placeholder:text-slate-500"
                    disabled={isPosting}
                />
                <button
                    type="submit"
                    disabled={isPosting || !content.trim()}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg shadow-lg shadow-emerald-900/30 disabled:opacity-50 transition-colors"
                >
                    <i className="fa-solid fa-paper-plane"></i>
                </button>
            </form>
        </div>
    );
};

const UnitRoster: React.FC<{ unitId: number }> = ({ unitId }) => {
    const { allUsers } = useMembers();
    const members = useMemo(() => allUsers.filter(u => u.unit?.id === unitId).sort((a, b) => (a.rank?.sortOrder || 999) - (b.rank?.sortOrder || 999)), [allUsers, unitId]);

    return (
        <div className="bg-slate-900/60 backdrop-blur-md rounded-xl border border-slate-700/50 overflow-hidden flex flex-col h-full max-h-[600px]">
            <div className="px-5 py-4 border-b border-white/5 bg-white/5 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-300">
                        <i className="fa-solid fa-users-viewfinder text-sm"></i>
                    </div>
                    <h3 className="font-bold text-white text-sm uppercase tracking-wider">Active Roster</h3>
                </div>
                <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">{members.length} PAX</span>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                {members.map(m => (
                    <div key={m.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/50 transition-colors group">
                        <div className="relative shrink-0">
                            <img src={m.avatarUrl} className="w-8 h-8 rounded-full border border-slate-700 object-cover" />
                            <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-900 ${m.isDuty ? 'bg-green-500' : 'bg-slate-600'}`}></div>
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-slate-200 truncate group-hover:text-white transition-colors">{m.name}</p>
                            <p className="text-[10px] text-slate-500 uppercase truncate tracking-widest">{m.rank?.name}</p>
                        </div>
                        {m.unit?.leaderId === m.id && <i className="fa-solid fa-crown text-amber-400 text-xs" title="Unit Leader"></i>}
                    </div>
                ))}
            </div>
        </div>
    );
};

const UnitCalendar: React.FC<{ unitId: number }> = ({ unitId }) => {
    const { operations } = useOperations();
    const fmt = useFormatDate();
    const unitOps = useMemo(() =>
        operations
            .filter(op => op.unitId === unitId || op.unit?.id === unitId)
            .sort((a, b) => new Date(a.activeStartTime || a.createdAt).getTime() - new Date(b.activeStartTime || b.createdAt).getTime()),
        [operations, unitId]);

    const upcoming = unitOps.filter(op => op.status !== 'Concluded');

    return (
        <div className="bg-slate-900/60 backdrop-blur-md rounded-xl border border-slate-700/50 overflow-hidden flex flex-col h-full max-h-[600px]">
            <div className="px-5 py-4 border-b border-white/5 bg-white/5 flex items-center gap-3 shrink-0">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-300">
                    <i className="fa-solid fa-calendar-days text-sm"></i>
                </div>
                <h3 className="font-bold text-white text-sm uppercase tracking-wider">Deployment Schedule</h3>
            </div>
            <div className="p-4 space-y-3 flex-1 overflow-y-auto custom-scrollbar">
                {upcoming.length > 0 ? upcoming.map(op => (
                    <div key={op.id} className="bg-slate-900/80 border border-slate-700/50 p-3 rounded-xl flex items-center justify-between group hover:border-purple-500/30 transition-all">
                        <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${op.isTraining ? 'bg-green-500/10 text-green-300 border-green-500/30' : 'bg-red-500/10 text-red-300 border-red-500/30'}`}>
                                <i className={`fa-solid ${op.isTraining ? 'fa-dumbbell' : 'fa-crosshairs'}`}></i>
                            </div>
                            <div>
                                <h4 className="font-bold text-white text-sm group-hover:text-purple-300 transition-colors">{op.name}</h4>
                                <p className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">
                                    {op.activeStartTime ? fmt(op.activeStartTime) : 'TBD'}
                                </p>
                            </div>
                        </div>
                        <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-sm border ${op.status === 'Active' ? 'bg-green-500/10 text-green-300 border-green-500/30 animate-pulse' : 'bg-slate-500/10 text-slate-400 border-slate-500/30'}`}>
                            {op.status}
                        </span>
                    </div>
                )) : (
                    <div className="flex items-center justify-center h-full">
                        <EmptyState icon="fa-calendar-xmark" accent="emerald" heading="No upcoming operations" compact />
                    </div>
                )}
            </div>
        </div>
    );
};

// When `unit` is omitted (HR Hub My Unit tab), renders the current user's own
// unit; when passed explicitly (e.g. browsing other units via the Org Chart),
// renders that unit. The "Edit Profile" button only shows for the unit leader.
interface MyUnitViewProps {
    unit?: OrganizationalUnit;
}

const MyUnitView: React.FC<MyUnitViewProps> = ({ unit: extUnit }) => {
    const { currentUser } = useAuth();
    const { openUnitModal } = useModalRegistry();

    const unit = extUnit || currentUser?.unit;
    if (!unit) {
        return (
            <div className="flex items-center justify-center py-20 animate-fade-in">
                <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 max-w-md w-full">
                    <EmptyState
                        icon="fa-users-slash"
                        accent="emerald"
                        heading="No Unit Assignment"
                        description="You are currently in the General Pool. Contact HR or Command to be assigned to a specific operational unit."
                    />
                </div>
            </div>
        );
    }

    const isLeader = unit.leaderId === currentUser?.id;

    return (
        <div className="space-y-6 animate-fade-in pb-10">
            {/* Hero Header */}
            <div className="relative rounded-xl overflow-hidden border border-slate-700/50 shadow-lg bg-slate-900 group">
                <div className="absolute inset-0">
                    {unit.bannerUrl ? (
                        <img src={unit.bannerUrl} className="w-full h-full object-cover opacity-40 group-hover:opacity-50 transition-opacity duration-700" alt="Banner" />
                    ) : (
                        <div className="w-full h-full bg-linear-to-r from-slate-900 via-emerald-900/20 to-slate-900"></div>
                    )}
                    <div className="absolute inset-0 bg-linear-to-t from-slate-950 via-slate-950/60 to-transparent"></div>
                </div>

                <div className="relative z-10 p-6 md:p-8 flex flex-col md:flex-row items-center md:items-end gap-6 text-center md:text-left">
                    <div className="w-24 h-24 md:w-28 md:h-28 rounded-xl bg-slate-800 border-2 border-emerald-500/30 flex items-center justify-center shadow-xl overflow-hidden shrink-0">
                        {unit.logoUrl ? (
                            <img src={unit.logoUrl} className="w-full h-full object-cover" alt="Logo" />
                        ) : (
                            <i className="fa-solid fa-shield-halved text-4xl text-emerald-300"></i>
                        )}
                    </div>
                    <div className="flex-1 pb-2 min-w-0">
                        <h1 className="text-3xl md:text-4xl font-black text-white tracking-tight uppercase drop-shadow-lg">{unit.name}</h1>
                        <p className="text-emerald-300 font-serif italic text-base md:text-lg mt-1">"{unit.motto || 'Strength in Unity'}"</p>
                        <p className="text-slate-300 text-sm mt-3 max-w-2xl leading-relaxed hidden md:block">{unit.description}</p>
                    </div>
                    {isLeader && (
                        <button
                            onClick={() => openUnitModal(unit)}
                            className="flex items-center gap-2 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-emerald-300 bg-slate-900/60 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/10 backdrop-blur-xs transition"
                        >
                            <i className="fa-solid fa-pen-to-square"></i> Edit Profile
                        </button>
                    )}
                </div>
            </div>

            {unit.description && (
                <div className="md:hidden bg-slate-900/60 p-4 rounded-xl border border-slate-700/50 text-sm text-slate-300 text-center italic">
                    "{unit.description}"
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="space-y-6 flex flex-col">
                    <UnitRoster unitId={unit.id} />
                    <UnitCalendar unitId={unit.id} />
                </div>

                <div className="lg:col-span-2">
                    <UnitFeed unitId={unit.id} />
                </div>
            </div>
        </div>
    );
};

export default MyUnitView;
