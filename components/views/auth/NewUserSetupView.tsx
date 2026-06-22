import React, { useState } from 'react';
import { BrandingConfig } from '../../../types';

interface NewUserSetupViewProps {
    pendingUser: { name: string; avatarUrl: string; isAdminSetup?: boolean; verificationCode?: string };
    onSetupComplete: (rsiHandle: string, verificationCode: string) => Promise<void>;
    isAdminSetup: boolean;
    brandingConfig: BrandingConfig;
}

const NewUserSetupView: React.FC<NewUserSetupViewProps> = ({ pendingUser, onSetupComplete, isAdminSetup, brandingConfig }) => {
    const [step, setStep] = useState<'INPUT' | 'VERIFY'>('INPUT');
    const [rsiHandle, setRsiHandle] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    // Server-issued in auth:discord_callback. The user pastes THIS into their RSI
    // bio; the server checks the profile for the same code it signed into the grant,
    // so the code can't be a client-chosen value that already appears on a page.
    const verificationCode = pendingUser.verificationCode || '';

    const handleNext = (e: React.FormEvent) => {
        e.preventDefault();
        if (rsiHandle.trim()) {
            setStep('VERIFY');
            setError(null);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (rsiHandle.trim() && verificationCode) {
            setIsLoading(true);
            setError(null);
            try {
                await onSetupComplete(rsiHandle.trim(), verificationCode);
            } catch (err: any) {
                setError(err.message || "Verification failed. Ensure the code is correctly saved in your RSI bio.");
            } finally {
                setIsLoading(false);
            }
        }
    };

    const copyToClipboard = () => {
        navigator.clipboard.writeText(verificationCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 p-6 relative overflow-hidden font-sans">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(14,165,233,0.1)_0%,transparent_70%)] pointer-events-none"></div>
            <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-size-[40px_40px] pointer-events-none"></div>

            <div className="w-full max-w-lg relative z-10 animate-fade-in-up space-y-6">

                <div className="bg-slate-900/60 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden relative">
                    <div className="absolute top-0 left-0 w-full h-1 bg-linear-to-r from-sky-600 via-indigo-500 to-sky-600"></div>

                    <div className="p-8 md:p-10 text-center">
                        <div className="w-16 h-16 bg-sky-500/10 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-sky-500/20 shadow-[0_0_30px_rgba(14,165,233,0.2)]">
                            <img src={brandingConfig.iconUrl} alt="Logo" className="w-10 h-10 drop-shadow-md" />
                        </div>

                        <h1 className="text-2xl font-black text-white tracking-tight mb-1 uppercase">{brandingConfig.name}</h1>
                        <p className="text-sky-200/60 font-mono text-[10px] uppercase tracking-[0.3em] mb-8">Identity_Provisioning_Protocol</p>

                        <div className="mb-10">
                            <h2 className="text-xl font-bold text-white mb-4">Welcome, {pendingUser.name}!</h2>
                            <div className="relative inline-block group">
                                <div className="absolute -inset-1 bg-linear-to-r from-sky-500 to-indigo-500 rounded-full blur-sm opacity-25 group-hover:opacity-50 transition duration-1000"></div>
                                <img src={pendingUser.avatarUrl} alt="Avatar" className="relative h-20 w-20 rounded-full mx-auto border-2 border-slate-700 shadow-xl object-cover" />
                            </div>
                        </div>

                        {step === 'INPUT' ? (
                            <form onSubmit={handleNext} className="space-y-6 text-left animate-fade-in">
                                <p className="text-sm text-slate-400 text-center leading-relaxed">
                                    {isAdminSetup
                                        ? "Initiating Administrative Access. Provide your RSI Handle for identity anchoring."
                                        : "One last step! Provide your unique RSI Handle for terminal verification."}
                                </p>

                                <div className="space-y-2">
                                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">RSI Handle</label>
                                    <input
                                        type="text"
                                        value={rsiHandle}
                                        onChange={(e) => setRsiHandle(e.target.value)}
                                        className="w-full bg-black/40 border border-slate-700 rounded-xl p-4 text-white font-mono focus:border-sky-500 focus:ring-1 focus:ring-sky-500/50 outline-hidden transition-all placeholder:text-slate-700"
                                        placeholder="Citizen_ID..."
                                        required
                                        autoFocus
                                    />
                                </div>

                                <button type="submit" className="w-full py-4 bg-sky-600 hover:bg-sky-500 text-white font-black uppercase tracking-[0.2em] rounded-xl shadow-lg shadow-sky-900/20 transition-all active:scale-95 text-xs">
                                    Next Step <i className="fa-solid fa-arrow-right ml-2"></i>
                                </button>
                            </form>
                        ) : (
                            <div className="space-y-6 text-left animate-fade-in">
                                <div className="bg-black/40 border border-slate-800 rounded-xl p-5">
                                    <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1">Target Identity</p>
                                    <p className="text-lg font-bold text-white font-mono">{rsiHandle}</p>
                                </div>

                                <div className="space-y-4">
                                    <p className="text-[10px] font-black text-sky-500 uppercase tracking-widest">Verification Sequence</p>
                                    <div className="bg-slate-800/30 border border-slate-700/50 rounded-xl p-4 space-y-4 text-xs leading-relaxed">
                                        <div className="flex gap-3">
                                            <span className="text-sky-500 font-mono">01</span>
                                            <p className="text-slate-300">Visit <a href="https://robertsspaceindustries.com/account/profile" target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">rsi.com/account/profile</a></p>
                                        </div>
                                        <div className="flex gap-3">
                                            <span className="text-sky-500 font-mono">02</span>
                                            <div className="flex-1 space-y-2">
                                                <p className="text-slate-300">Copy this whitelabel verification code:</p>
                                                <div className="flex items-center bg-black/60 rounded-lg border border-sky-500/30 overflow-hidden group hover:border-sky-500/60 transition-colors">
                                                    <span className="flex-1 font-mono text-sky-400 px-3 py-2 select-all">{verificationCode}</span>
                                                    <button type="button" onClick={copyToClipboard} className={`px-3 py-2 text-[10px] font-black uppercase transition-all ${copied ? 'bg-green-600 text-white' : 'bg-sky-900/40 text-sky-400 hover:bg-sky-600 hover:text-white'}`}>
                                                        {copied ? 'Copied' : 'Copy'}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex gap-3">
                                            <span className="text-sky-500 font-mono">03</span>
                                            <p className="text-slate-300">Paste the code into your <strong>"Bio"</strong> section and save.</p>
                                        </div>
                                    </div>
                                </div>

                                {error && (
                                    <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-xl text-xs flex items-start gap-3 animate-pulse">
                                        <i className="fa-solid fa-circle-exclamation mt-0.5"></i>
                                        <p>{error}</p>
                                    </div>
                                )}

                                <div className="flex gap-3 pt-2">
                                    <button onClick={() => setStep('INPUT')} className="flex-1 py-4 bg-slate-800 hover:bg-slate-700 text-slate-400 font-bold uppercase tracking-widest rounded-xl text-xs transition-all">
                                        Back
                                    </button>
                                    <button onClick={handleSubmit} disabled={isLoading} className="flex-2 py-4 bg-sky-600 hover:bg-sky-500 text-white font-black uppercase tracking-[0.2em] rounded-xl shadow-lg shadow-sky-900/20 transition-all active:scale-95 text-xs disabled:opacity-50">
                                        {isLoading ? <><i className="fa-solid fa-circle-notch animate-spin mr-2" /> Syncing...</> : "Verify & Link"}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="bg-black/20 p-4 border-t border-white/5 flex justify-between items-center text-[10px] text-slate-600 font-mono uppercase tracking-wider">
                        <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse"></div> Secure Enrollment</span>
                        <span>NODE_VERIFY_v2.1</span>
                    </div>
                </div>

                <div className="text-center">
                    <p className="text-[10px] text-slate-700 uppercase tracking-widest">
                        Unauthorized access is monitored. Log: {new Date().toISOString().substring(0, 10)}
                    </p>
                </div>
            </div>
        </div>
    );
};

export default NewUserSetupView;