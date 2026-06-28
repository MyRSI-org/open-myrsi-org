
import React, { useMemo } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useHR } from '../../../contexts/HRContext';
import { useOperations } from '../../../contexts/OperationsContext';
import { ServiceRequestStatus, UserRole, ApplicationStatus, OperationStatus } from '../../../types';
import {
    AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, Label,
    XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { HeroStat, SectionPanel } from '../../shared/ui';

const CHART_COLORS = {
    success: '#10b981', active: '#3b82f6',
    pending: '#f59e0b', failed: '#ef4444',
    aborted: '#f97316', sky: '#38bdf8', purple: '#a855f7'
};

const AXIS_STYLE = { fontSize: 11, fill: '#64748b', fontFamily: 'monospace' };

const tooltipStyle = {
    contentStyle: { backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px', color: '#fff', fontSize: 12, fontFamily: 'monospace' },
    itemStyle: { color: '#94a3b8' },
    cursor: { fill: 'rgba(148, 163, 184, 0.05)' }
};

const AnalyticsDashboard: React.FC = () => {
    const { hydratedServiceRequests } = useData();
    const { allUsers } = useMembers();
    const { hrApplicants } = useHR();
    const { operations } = useOperations();

    const stats = useMemo(() => {
        const totalUsers = allUsers.length;
        const members = allUsers.filter(u => u.role !== UserRole.Client).length;
        const clients = totalUsers - members;
        const totalRequests = hydratedServiceRequests.length;
        const activeRequests = hydratedServiceRequests.filter(r => r.status === ServiceRequestStatus.Submitted || r.status === ServiceRequestStatus.InProgress).length;
        const completedRequests = hydratedServiceRequests.filter(r => r.status === ServiceRequestStatus.Success).length;
        const successRate = totalRequests > 0 ? Math.round((completedRequests / totalRequests) * 100) : 0;

        const totalApplications = hrApplicants.length;
        const newApplications = hrApplicants.filter(a => a.status === ApplicationStatus.Applied).length;

        const activeOps = operations.filter(o => o.status === OperationStatus.Planning || o.status === OperationStatus.Active).length;

        const now = new Date();
        const timelineData: { name: string; success: number; active: number; cancelled: number; failed: number; aborted: number }[] = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const dateKey = d.toISOString().split('T')[0];
            const label = d.toLocaleDateString('en-US', { weekday: 'short' });
            const entry = { name: label, dateKey, success: 0, active: 0, cancelled: 0, failed: 0, aborted: 0 };

            hydratedServiceRequests.forEach(r => {
                const rd = new Date(r.updatedAt || r.createdAt);
                if (rd.toISOString().split('T')[0] === dateKey) {
                    if (r.status === ServiceRequestStatus.Success) entry.success++;
                    else if (r.status === ServiceRequestStatus.Failed || r.status === ServiceRequestStatus.Refused) entry.failed++;
                    else if (r.status === ServiceRequestStatus.Cancelled) entry.cancelled++;
                    else if (r.status === ServiceRequestStatus.Aborted || r.status === ServiceRequestStatus.GameError) entry.aborted++;
                    else entry.active++;
                }
            });

            timelineData.push(entry);
        }

        const statusCounts: Record<string, number> = {};
        hydratedServiceRequests.forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
        const pieData = [
            { name: 'Success', value: statusCounts[ServiceRequestStatus.Success] || 0, color: CHART_COLORS.success },
            { name: 'Active', value: (statusCounts[ServiceRequestStatus.InProgress] || 0) + (statusCounts[ServiceRequestStatus.Accepted] || 0), color: CHART_COLORS.active },
            { name: 'Pending', value: (statusCounts[ServiceRequestStatus.Submitted] || 0) + (statusCounts[ServiceRequestStatus.Triaged] || 0), color: CHART_COLORS.pending },
            { name: 'Aborted', value: (statusCounts[ServiceRequestStatus.Aborted] || 0) + (statusCounts[ServiceRequestStatus.GameError] || 0), color: CHART_COLORS.aborted },
            { name: 'Failed', value: (statusCounts[ServiceRequestStatus.Failed] || 0) + (statusCounts[ServiceRequestStatus.Refused] || 0) + (statusCounts[ServiceRequestStatus.Cancelled] || 0), color: CHART_COLORS.failed },
        ].filter(d => d.value > 0);

        const typeCounts: Record<string, number> = {};
        hydratedServiceRequests.forEach(r => {
            const type = r.serviceType || 'Unknown';
            typeCounts[type] = (typeCounts[type] || 0) + 1;
        });
        const demandData = Object.entries(typeCounts)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 7);

        const months: { name: string; count: number }[] = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push({ name: d.toLocaleString('default', { month: 'short' }), count: 0 });
        }
        allUsers.forEach(u => {
            const joined = new Date(u.createdAt || now.getTime());
            const diffDays = Math.ceil(Math.abs(now.getTime() - joined.getTime()) / (1000 * 60 * 60 * 24));
            if (diffDays <= 180) {
                const key = joined.toLocaleString('default', { month: 'short' });
                const entry = months.find(m => m.name === key);
                if (entry) entry.count++;
            }
        });

        return {
            members, clients, activeRequests, totalUsers, totalRequests, successRate,
            totalApplications, newApplications, activeOps,
            timelineData, pieData, demandData, userGrowth: months
        };
    }, [allUsers, hydratedServiceRequests, hrApplicants, operations]);

    const totalMissions = stats.pieData.reduce((s, d) => s + d.value, 0);

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in overflow-x-hidden">
            {/* Secondary stats row (complements shell hero) */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <HeroStat icon="fa-crosshairs" label="Success Rate" value={`${stats.successRate}%`} sub={`${stats.totalRequests} missions`} accent="emerald" />
                <HeroStat icon="fa-file-signature" label="Pending Applications" value={stats.newApplications} sub={`${stats.totalApplications} total`} accent="purple" emphasize={stats.newApplications > 0} />
                <HeroStat icon="fa-jet-fighter" label="Active Operations" value={stats.activeOps} accent="rose" emphasize={stats.activeOps > 0} />
                <HeroStat icon="fa-address-book" label="Registered Clients" value={stats.clients} accent="sky" />
            </div>

            {/* 7-Day Activity Stream */}
            <SectionPanel
                icon="fa-solid fa-timeline"
                title="7-Day Activity Stream"
                actions={
                    <div className="hidden md:flex flex-wrap gap-3 text-[10px] font-black uppercase tracking-widest">
                        <span className="flex items-center gap-1.5 text-emerald-300"><span className="w-2 h-2 rounded-full bg-emerald-500"></span>Success</span>
                        <span className="flex items-center gap-1.5 text-blue-300"><span className="w-2 h-2 rounded-full bg-blue-500"></span>Active</span>
                        <span className="flex items-center gap-1.5 text-amber-300"><span className="w-2 h-2 rounded-full bg-amber-500"></span>Cancelled</span>
                        <span className="flex items-center gap-1.5 text-orange-300"><span className="w-2 h-2 rounded-full bg-orange-500"></span>Aborted</span>
                        <span className="flex items-center gap-1.5 text-red-300"><span className="w-2 h-2 rounded-full bg-red-500"></span>Failed</span>
                    </div>
                }
            >
                <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={stats.timelineData} margin={{ top: 10, right: 5, left: -15, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <XAxis dataKey="name" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
                        <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} allowDecimals={false} />
                        <Tooltip {...tooltipStyle} />
                        <Bar dataKey="success" stackId="1" fill={CHART_COLORS.success} radius={[0, 0, 0, 0]} />
                        <Bar dataKey="active" stackId="1" fill={CHART_COLORS.active} />
                        <Bar dataKey="cancelled" stackId="1" fill={CHART_COLORS.pending} />
                        <Bar dataKey="aborted" stackId="1" fill={CHART_COLORS.aborted} />
                        <Bar dataKey="failed" stackId="1" fill={CHART_COLORS.failed} radius={[3, 3, 0, 0]} />
                    </BarChart>
                </ResponsiveContainer>
            </SectionPanel>

            {/* Middle Row: Pie + Horizontal Bar */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <SectionPanel icon="fa-solid fa-chart-pie" title="Mission Outcomes">
                    <ResponsiveContainer width="100%" height={250}>
                        <PieChart>
                            <Pie
                                data={stats.pieData}
                                cx="50%"
                                cy="50%"
                                innerRadius="55%"
                                outerRadius="80%"
                                paddingAngle={3}
                                dataKey="value"
                                stroke="none"
                            >
                                {stats.pieData.map((entry) => (
                                    <Cell key={entry.name} fill={entry.color} />
                                ))}
                                <Label
                                    value={totalMissions}
                                    position="center"
                                    style={{ fontSize: 28, fontWeight: 'bold', fill: '#fff', fontFamily: 'monospace' }}
                                />
                            </Pie>
                            <Tooltip {...tooltipStyle} />
                        </PieChart>
                    </ResponsiveContainer>
                    <div className="flex flex-wrap justify-center gap-4 mt-2 text-[10px] font-black uppercase tracking-widest">
                        {stats.pieData.map(d => (
                            <span key={d.name} className="flex items-center gap-1.5" style={{ color: d.color }}>
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }}></span>
                                {d.name} ({d.value})
                            </span>
                        ))}
                    </div>
                </SectionPanel>

                <SectionPanel icon="fa-solid fa-list-check" title="Service Demand">
                    <ResponsiveContainer width="100%" height={280}>
                        <BarChart data={stats.demandData} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                            <XAxis type="number" tick={AXIS_STYLE} axisLine={false} tickLine={false} allowDecimals={false} />
                            <YAxis type="category" dataKey="name" tick={{ ...AXIS_STYLE, fontSize: 10 }} axisLine={false} tickLine={false} width={70} />
                            <Tooltip {...tooltipStyle} />
                            <Bar dataKey="value" fill={CHART_COLORS.sky} radius={[0, 4, 4, 0]} barSize={20} />
                        </BarChart>
                    </ResponsiveContainer>
                </SectionPanel>
            </div>

            {/* Recruitment Velocity */}
            <SectionPanel icon="fa-solid fa-chart-line" title="Recruitment Velocity (Last 6 Months)">
                <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={stats.userGrowth} margin={{ top: 10, right: 5, left: -15, bottom: 0 }}>
                        <defs>
                            <linearGradient id="gradPurple" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={CHART_COLORS.purple} stopOpacity={0.3} />
                                <stop offset="95%" stopColor={CHART_COLORS.purple} stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <XAxis dataKey="name" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
                        <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} allowDecimals={false} />
                        <Tooltip {...tooltipStyle} />
                        <Area type="monotone" dataKey="count" stroke={CHART_COLORS.purple} fill="url(#gradPurple)" strokeWidth={2} dot={{ fill: CHART_COLORS.purple, r: 3 }} activeDot={{ r: 5 }} />
                    </AreaChart>
                </ResponsiveContainer>
            </SectionPanel>
        </div>
    );
};

export default AnalyticsDashboard;
