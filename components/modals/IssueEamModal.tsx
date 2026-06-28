
import React, { useState, useEffect } from 'react';
import { useData } from '../../contexts/DataContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';
import { useNavigation } from '../../contexts/NavigationContext';

interface IssueEamModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const IssueEamModal: React.FC<IssueEamModalProps> = ({ isOpen, onClose }) => {
    const { broadcastEAM } = useData();
    const { addToast } = useNotification();
    const { setEamMessage } = useNavigation();
    const [message, setMessage] = useState('');
    const [isArming, setIsArming] = useState(false);
    const [armCountdown, setArmCountdown] = useState(3);
    const [isArmed, setIsArmed] = useState(false);
    const [isTransmitting, setIsTransmitting] = useState(false);

    // Reset the arming state machine each time the modal transitions closed ->
    // open. Done during render via React's "adjust state during render" pattern
    // (a prevIsOpen tracker) so the form is already cleared on the open frame
    // rather than a frame later from an effect. Same fields, same values, same
    // open-edge condition as the previous effect.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    if (isOpen !== prevIsOpen) {
        setPrevIsOpen(isOpen);
        if (isOpen) {
            setMessage('');
            setIsArming(false);
            setArmCountdown(3);
            setIsArmed(false);
            setIsTransmitting(false);
        }
    }

    useEffect(() => {
        if (!isArming) return;
        // Tick the countdown once per second. On the final tick (1 -> 0) we also
        // flip to "armed" from inside the timeout callback rather than
        // synchronously in the effect body, preserving the exact 3s cadence and
        // the original "armed immediately when the count reaches 0" behavior.
        const timer = window.setTimeout(() => {
            setArmCountdown(prev => prev - 1);
            if (armCountdown <= 1) {
                setIsArmed(true);
                setIsArming(false);
            }
        }, 1000);
        return () => clearTimeout(timer);
    }, [isArming, armCountdown]);

    const handleArmClick = () => {
        if (!message.trim()) return;
        setIsArming(true);
        setArmCountdown(3);
    };

    const handleTransmit = async () => {
        if (!isArmed || !message.trim()) return;
        setIsTransmitting(true);
        try {
            await broadcastEAM(message.toUpperCase());
            setEamMessage(message.toUpperCase());
            setTimeout(() => {
                onClose();
            }, 1000);
        } catch (err) {
            console.error(err);
            addToast("Transmission Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "EAM broadcast could not be transmitted. Please try again." });
            setIsTransmitting(false);
        }
    };

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Issue EAM"
            subtitle="Priority Interrupt Protocol"
            icon="fa-solid fa-radiation"
            color="red"
            width="max-w-lg"
        >
            <div className="p-0 flex flex-col h-full bg-black/40">

                {/* Warning Content */}
                <div className="p-8 relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1 bg-red-600 shadow-[0_0_20px_rgba(220,38,38,0.8)] z-10 animate-pulse"></div>
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-5">
                        <span className="text-9xl font-black text-red-600 uppercase -rotate-12">ALERT</span>
                    </div>

                    <p className="text-xs text-red-300 mb-6 font-mono border-l-2 border-red-500 pl-3 relative z-10 bg-red-950/30 p-2 rounded-r">
                        WARNING: Triggers full-screen override on all terminals. Use only for critical emergencies.
                    </p>

                    <label className="block text-[10px] text-red-400 uppercase font-black mb-2 tracking-wider relative z-10">Message Content</label>
                    <textarea
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        className="w-full bg-slate-900/90 border border-red-500/30 rounded-lg p-4 text-red-50 font-mono text-lg uppercase focus:border-red-500 focus:ring-1 focus:ring-red-500 outline-hidden h-32 resize-none shadow-inner relative z-10 backdrop-blur-xs"
                        placeholder="ENTER EAM CONTENT..."
                        disabled={isArming || isArmed || isTransmitting}
                    />
                </div>

                {/* Footer Controls */}
                <div className="p-4 bg-slate-900/80 border-t border-red-900/30 flex gap-3 z-20">
                    {!isArmed ? (
                        <button
                            onClick={handleArmClick}
                            disabled={!message.trim() || isArming}
                            className={`w-full py-4 font-black uppercase tracking-widest rounded-lg transition-all flex items-center justify-center gap-2 text-sm shadow-lg ${isArming
                                ? 'bg-red-900/50 text-red-300 border border-red-500 cursor-wait'
                                : 'bg-red-500/10 text-red-400 border border-red-500/50 hover:bg-red-500/20 hover:text-white hover:shadow-[0_0_20px_rgba(220,38,38,0.3)] disabled:opacity-50 disabled:cursor-not-allowed'
                                }`}
                        >
                            {isArming ? (
                                <><i className="fa-solid fa-spinner animate-spin"></i> Arming... {armCountdown}</>
                            ) : (
                                <><i className="fa-solid fa-shield-halved"></i> Arm System</>
                            )}
                        </button>
                    ) : (
                        <button
                            onClick={handleTransmit}
                            disabled={isTransmitting}
                            className="w-full py-4 bg-red-600 hover:bg-red-500 text-white font-black uppercase tracking-[0.2em] rounded-lg shadow-[0_0_30px_rgba(220,38,38,0.5)] transition-all flex items-center justify-center gap-3 animate-pulse active:scale-95"
                        >
                            {isTransmitting ? (
                                <><i className="fa-solid fa-spinner animate-spin"></i> TRANSMITTING</>
                            ) : (
                                <><i className="fa-solid fa-key"></i> EXECUTE</>
                            )}
                        </button>
                    )}
                </div>
            </div>
        </WindowFrame>
    );
};

export default IssueEamModal;
