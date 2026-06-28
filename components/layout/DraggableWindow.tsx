
import React, { useState, useRef, useEffect } from 'react';

interface DraggableWindowProps {
    id: string;
    title: string;
    initialX: number;
    initialY: number;
    zIndex: number;
    onClose: (id: string) => void;
    onFocus: (id: string) => void;
    children: React.ReactNode;
}

const DraggableWindow: React.FC<DraggableWindowProps> = ({ id, title, initialX, initialY, zIndex, onClose, onFocus, children }) => {
    const [position, setPosition] = useState({ x: initialX, y: initialY });
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef({ x: 0, y: 0 });
    const windowRef = useRef<HTMLDivElement>(null);

    // Keep the window inside the viewport: if the stored position has drifted out of
    // bounds, clamp it back. Implemented with React's "adjust state during render" pattern
    // (a guarded, convergent setState during render) rather than an effect — React applies
    // the clamp before paint, and because the snap target is strictly inside the trigger
    // threshold (innerWidth-320 < innerWidth-100) it converges in one re-render with no
    // loop. The drag math reads dragStartRef + the mouse event, never `position`, so
    // clamping the stored position does not affect drag offsets.
    if (typeof window !== 'undefined') {
        const maxX = window.innerWidth - 100;
        const maxY = window.innerHeight - 100;
        const clampedX = position.x > maxX ? window.innerWidth - 320 : position.x;
        const clampedY = position.y > maxY ? window.innerHeight - 200 : position.y;
        if (clampedX !== position.x || clampedY !== position.y) {
            setPosition({ x: clampedX, y: clampedY });
        }
    }

    const handleMouseDown = (e: React.MouseEvent) => {
        onFocus(id);
        setIsDragging(true);
        dragStartRef.current = {
            x: e.clientX - position.x,
            y: e.clientY - position.y
        };
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;

            const newX = e.clientX - dragStartRef.current.x;
            const newY = e.clientY - dragStartRef.current.y;

            // Simple boundaries
            // newX = Math.max(0, Math.min(newX, window.innerWidth - 300));
            // newY = Math.max(50, Math.min(newY, window.innerHeight - 100));

            setPosition({
                x: newX,
                y: newY
            });
        };

        const handleMouseUp = () => {
            setIsDragging(false);
        };

        if (isDragging) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        }

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging]);

    return (
        <div
            ref={windowRef}
            className="fixed w-96 bg-slate-900/90 backdrop-blur-md border border-slate-600 rounded-lg shadow-2xl flex flex-col overflow-hidden animate-fade-in"
            style={{
                left: position.x,
                top: position.y,
                zIndex: zIndex,
                minHeight: '200px',
                maxHeight: '80vh',
            }}
            onMouseDown={() => onFocus(id)}
        >
            {/* Header / Drag Handle */}
            <div
                className="bg-slate-800/80 border-b border-slate-700 p-2 flex justify-between items-center cursor-move select-none"
                onMouseDown={handleMouseDown}
            >
                <div className="flex items-center space-x-2 px-1">
                    <i className="fa-solid fa-grip-vertical text-slate-500 text-xs"></i>
                    <h3 className="text-sm font-bold text-sky-400 truncate max-w-[200px]">{title}</h3>
                </div>
                <div className="flex items-center space-x-1">
                    <button
                        onClick={(e) => { e.stopPropagation(); onClose(id); }}
                        className="text-slate-400 hover:text-white hover:bg-red-500/20 rounded-sm p-1 transition-colors"
                    >
                        <i className="fa-solid fa-xmark h-4 w-4"></i>
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar text-sm text-slate-300">
                {children}
            </div>
        </div>
    );
};

export default DraggableWindow;
