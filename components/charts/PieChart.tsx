
import React from 'react';

interface PieChartProps {
    data: { name: string; value: number }[];
    title: string;
    icon: React.ReactNode;
    unit?: string;
}

const PieChart: React.FC<PieChartProps> = ({ data, title, icon, unit = '' }) => {
    const total = data.reduce((acc, item) => acc + item.value, 0);
    const colors = ['#38bdf8', '#34d399', '#facc15', '#fb923c', '#f87171', '#c084fc', '#818cf8', '#a3e635', '#22d3ee', '#f472b6'];
    
    const segments = data.reduce<{ name: string; value: number; percent: number; offset: number; color: string }[]>((acc, item, index) => {
        const percent = total > 0 ? (item.value / total) * 100 : 0;
        const cumulativePercent = acc.reduce((sum, seg) => sum + seg.percent, 0);
        const offset = 25 - cumulativePercent;
        acc.push({ ...item, percent, offset, color: colors[index % colors.length] });
        return acc;
    }, []);

    return (
        <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 p-4 h-full flex flex-col">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center border-b border-slate-700/50 pb-2">
                <span className="mr-2 text-sky-500 text-base flex items-center justify-center">{icon}</span> {title}
            </h3>
            <div className="flex-1 min-h-0 flex items-center justify-center">
                {total > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full h-full items-center">
                        <div className="relative w-full h-full max-h-32 min-h-[120px] flex items-center justify-center">
                            <svg viewBox="0 0 36 36" className="h-full w-auto max-w-full">
                                <circle cx="18" cy="18" r="15.9155" className="stroke-slate-700" strokeWidth="3" fill="transparent" />
                                {segments.map((segment) => (
                                    <circle
                                        key={segment.name}
                                        cx="18" cy="18" r="15.9155"
                                        stroke={segment.color} strokeWidth="3" fill="transparent"
                                        strokeDasharray={`${segment.percent} ${100 - segment.percent}`}
                                        strokeDashoffset={segment.offset}
                                    />
                                ))}
                            </svg>
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <div className="text-center">
                                    <span className="text-xl font-bold text-white block leading-none">{total.toLocaleString()}</span>
                                    {unit && <span className="text-[10px] text-slate-400 block uppercase mt-0.5">{unit}</span>}
                                </div>
                            </div>
                        </div>
                        <div className="space-y-1.5 text-xs overflow-y-auto max-h-[140px] pr-2 custom-scrollbar">
                            {segments.sort((a,b) => b.value - a.value).map((segment) => (
                                <div key={segment.name} className="flex items-center justify-between">
                                   <div className="flex items-center truncate mr-2">
                                        <span className="h-2 w-2 rounded-full mr-2 shrink-0" style={{ backgroundColor: segment.color }}></span>
                                        <span className="text-slate-300 truncate" title={segment.name}>{segment.name}</span>
                                   </div>
                                   <div className="text-right shrink-0">
                                        <span className="font-semibold text-white">{segment.value.toLocaleString()}</span>
                                        <span className="text-[10px] text-slate-500 ml-1">({segment.percent.toFixed(0)}%)</span>
                                   </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center justify-center h-full">
                        <p className="text-slate-500 text-sm italic">No data available.</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default PieChart;
