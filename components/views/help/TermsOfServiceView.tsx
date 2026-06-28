
import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';
import parse from 'html-react-parser';
import { useConfig } from '../../../contexts/ConfigContext';
import CallsignChip from '../../shared/ui/CallsignChip';

interface TermsOfServiceViewProps {
    onBack: () => void;
}

const DEFAULT_TOS_CONTENT = `
<h2>1. Introduction to Services</h2>
<p>These Terms of Service ("Terms") create an agreement between <strong>you (the "Client")</strong> and <strong>the Organization</strong>.</p>
<p>By submitting a request through the Operations Portal, the Client acknowledges and accepts these Terms.</p>
<p>We provide the following service categories:</p>
<ul>
<li><strong>Security:</strong> escort, overwatch, deterrence, patrol, asset protection</li>
<li><strong>Rescue:</strong> personnel recovery, medical support, extraction from hazardous environments</li>
<li><strong>Logistics:</strong> cargo transport, delivery, supply chain assistance, lawful salvage recovery</li>
</ul>
<p>All operations are conducted <strong>in-game only</strong> within the <strong>LIVE</strong> PU environment.</p>

<h2>2. Availability and Response</h2>
<p>We operate on an <strong>on-duty personnel model</strong>. Response times may vary based on member availability.</p>
<p>We <strong>cannot guarantee</strong> immediate response or successful completion of any requested task.</p>

<h2>3. Limitations of Liability</h2>
<p>To the fullest extent permitted under UEE Civil Code, the Organization is <strong>not liable</strong> for loss of ships, vehicles, equipment, or in-game currency.</p>
`;

const TermsOfServiceView: React.FC<TermsOfServiceViewProps> = ({ onBack }) => {
    const { brandingConfig } = useConfig();
    const orgName = brandingConfig.name || "Organisation";

    // Use configured TOS or fallback to default
    const tosContent = useMemo(() => {
        const rawContent = brandingConfig.termsOfService || DEFAULT_TOS_CONTENT;
        return rawContent;
    }, [brandingConfig.termsOfService]);

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <div className="shrink-0 relative overflow-hidden border-b border-white/5 bg-linear-to-b from-sky-950/30 via-slate-950/80 to-slate-950">
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-sky-500/10 rounded-full blur-[120px] pointer-events-none" aria-hidden />

                <div className="relative px-4 sm:px-8 pt-10 pb-8">
                    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
                        <div className="min-w-0">
                            <CallsignChip label="MODULE · TERMS OF SERVICE" icon="fa-file-contract" accent="sky" />
                            <h1 className="mt-3 text-3xl sm:text-4xl font-black text-white tracking-tight leading-tight">
                                Terms of Service
                            </h1>
                            <p className="mt-2 text-sm text-slate-400 max-w-2xl">
                                {orgName} · Service agreement between the Client and the Organization.
                            </p>
                        </div>
                        <div className="flex shrink-0">
                            <button
                                onClick={onBack}
                                className="flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-widest text-slate-300 bg-slate-900/60 border border-slate-700 rounded-lg hover:border-sky-500/40 hover:bg-sky-500/10 hover:text-sky-300 transition-colors"
                            >
                                <i className="fa-solid fa-arrow-left"></i> Back to Help
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto w-full">
                <div className="bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-xl p-6 md:p-10 shadow-lg">
                    <div className="text-center mb-8 border-b border-white/5 pb-6">
                        <h2 className="text-2xl md:text-3xl font-black text-white uppercase tracking-wide">{orgName}</h2>
                        <p className="text-sky-300 font-black uppercase tracking-[0.2em] text-[10px] mt-2">Terms of Service Protocol</p>
                    </div>

                    <div
                        className="prose prose-invert prose-base max-w-none
                        prose-headings:text-sky-300 prose-headings:font-bold prose-headings:uppercase prose-headings:border-b prose-headings:border-white/5 prose-headings:pb-2 prose-headings:mt-8
                        prose-p:text-slate-300 prose-p:leading-relaxed
                        prose-li:text-slate-300
                        prose-strong:text-white prose-strong:font-bold"
                    >
                        {/* DOMPurify-sanitized, then rendered to React elements via
                            html-react-parser — no raw HTML injection. */}
                        {parse(DOMPurify.sanitize(tosContent))}
                    </div>

                    <div className="text-center text-slate-600 text-[10px] pt-8 mt-10 border-t border-white/5 font-mono uppercase tracking-widest">
                        <p>End of File</p>
                        <p>{orgName} {'//'} Operations Division</p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default TermsOfServiceView;
