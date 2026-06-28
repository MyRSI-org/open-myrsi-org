import React, { ReactNode, useEffect, useRef, useState } from 'react';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    maxHeight?: string;
    children: ReactNode;
}

const DRAG_DISMISS_THRESHOLD = 100;

export default function BottomSheet({ isOpen, onClose, title, maxHeight = '85vh', children }: Props) {
    const [dragOffset, setDragOffset] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const dragStartYRef = useRef<number | null>(null);
    const sheetRef = useRef<HTMLDivElement>(null);

    // Reset drag position so a subsequent open starts un-dragged. Done during
    // render via a previous-value tracker (the React "adjust state during
    // render" pattern) so the transient drag offset clears on the close
    // transition without a synchronous set-in-effect.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    if (isOpen !== prevIsOpen) {
        setPrevIsOpen(isOpen);
        if (!isOpen && dragOffset !== 0) {
            setDragOffset(0);
        }
    }

    useEffect(() => {
        if (!isOpen) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previous;
        };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [isOpen, onClose]);

    const handlePointerDown = (e: React.PointerEvent) => {
        dragStartYRef.current = e.clientY;
        setIsDragging(true);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (dragStartYRef.current == null) return;
        const delta = e.clientY - dragStartYRef.current;
        if (delta > 0) setDragOffset(delta);
    };

    const handlePointerEnd = () => {
        if (dragStartYRef.current == null) return;
        const finalOffset = dragOffset;
        dragStartYRef.current = null;
        setIsDragging(false);
        if (finalOffset > DRAG_DISMISS_THRESHOLD) {
            onClose();
        } else {
            setDragOffset(0);
        }
    };

    return (
        <div
            className={`fixed inset-0 z-40 md:hidden transition-opacity duration-200 ${
                isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
            }`}
            aria-hidden={!isOpen}
        >
            {/* Backdrop */}
            <div
                onClick={onClose}
                className="absolute inset-0 bg-slate-950/80 backdrop-blur-xs"
            />

            {/* Sheet */}
            <div
                ref={sheetRef}
                role="dialog"
                aria-modal="true"
                style={{
                    transform: isOpen ? `translateY(${dragOffset}px)` : 'translateY(100%)',
                    maxHeight,
                    transition: isDragging ? 'none' : 'transform 200ms ease-out',
                }}
                className="absolute left-0 right-0 bottom-0 bg-slate-950/95 backdrop-blur-xl border-t border-white/10 rounded-t-2xl shadow-2xl flex flex-col"
            >
                {/* Drag handle */}
                <div
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerEnd}
                    onPointerCancel={handlePointerEnd}
                    className="flex flex-col items-center pt-2 pb-1 cursor-grab active:cursor-grabbing touch-none select-none"
                >
                    <div className="w-10 h-1 bg-slate-700 rounded-sm" />
                </div>

                {/* Header (always rendered — onClose is required, title may be empty) */}
                <div className="flex items-center justify-between px-4 pb-3 border-b border-white/10">
                        {title ? (
                            <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.25em]">{title}</h2>
                        ) : <span />}
                        <button
                            onClick={onClose}
                            className="text-slate-500 hover:text-white text-sm w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-800 transition-colors"
                            aria-label="Close"
                        >
                            <i className="fa-solid fa-xmark" />
                        </button>
                    </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto overscroll-contain custom-scrollbar">
                    {children}
                </div>
            </div>
        </div>
    );
}
