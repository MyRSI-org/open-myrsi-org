import React, { Component, ErrorInfo, ReactNode } from 'react';
import { hardReload } from '../../lib/hardReload';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Uncaught error:', error, errorInfo);
    }

    public render() {
        if (this.state.hasError) {
            return this.props.fallback || (
                <div className="flex flex-col items-center justify-center h-full min-h-[400px] p-8 text-center bg-slate-900/50 rounded-xl border border-red-500/20">
                    <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mb-4">
                        <i className="fa-solid fa-triangle-exclamation text-2xl text-red-500"></i>
                    </div>
                    <h2 className="text-xl font-bold text-white mb-2">System Module Failure</h2>
                    <p className="text-slate-400 mb-6 max-w-md">
                        The requested component encountered a critical error or failed to load resource chunks.
                        {this.state.error?.message && <span className="block mt-2 font-mono text-xs bg-black/30 p-2 rounded-sm text-red-400">{this.state.error.message}</span>}
                    </p>
                    <button
                        onClick={() => { void hardReload(); }}
                        className="px-6 py-2 bg-red-600 hover:bg-red-500 text-white rounded-sm font-bold uppercase tracking-wider transition-colors shadow-lg"
                    >
                        Reinitialize System
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
