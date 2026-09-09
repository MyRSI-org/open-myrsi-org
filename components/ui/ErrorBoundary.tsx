import React, { Component, ErrorInfo, ReactNode } from 'react';
import { hardReload } from '../../lib/hardReload';

interface ErrorBoundaryProps {
  children?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * ErrorBoundary component to catch rendering errors in the component tree.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error, errorInfo: null };
  }

  // Use componentDidCatch to log and store error info
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
    this.setState({ errorInfo });
  }

  // Shared with the other ErrorBoundary and the update banner — a plain reload can be answered
  // by the service worker from its own cache, landing the user back on the same broken build.
  private handleReload = () => { void hardReload(); };

  render() {
    const { hasError, error, errorInfo } = this.state;

    if (hasError) {
      return (
        <div className="fixed inset-0 z-9999 flex flex-col items-center justify-center bg-slate-950 text-slate-300 p-6 font-sans">
          {/* Background Grid Effect */}
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-size-[40px_40px] pointer-events-none"></div>

          <div className="relative z-10 max-w-lg w-full bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
            <div className="h-1 w-full bg-red-600"></div>
            <div className="p-8 flex flex-col items-center text-center">
              <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mb-6 border border-red-500/30 shadow-[0_0_30px_rgba(220,38,38,0.2)] animate-pulse">
                <i className="fa-solid fa-triangle-exclamation text-4xl text-red-500"></i>
              </div>

              <h1 className="text-2xl font-black text-white uppercase tracking-widest mb-2">System Critical</h1>
              <p className="text-slate-400 text-sm mb-8 leading-relaxed">
                The operational terminal has encountered an unrecoverable error and must be restarted. This is likely due to an update to the application.
              </p>

              <div className="w-full bg-black/40 border border-slate-800 rounded-lg p-4 mb-8 text-left font-mono text-xs overflow-hidden">
                <p className="text-red-400 font-bold mb-2 uppercase flex items-center gap-2">
                  <i className="fa-solid fa-bug"></i> Exception Trace
                </p>
                <div className="text-red-200/70 whitespace-pre-wrap break-all max-h-32 overflow-y-auto custom-scrollbar">
                  {error?.toString() || "Unknown Error"}
                </div>
                {errorInfo && (
                  <details className="mt-4 border-t border-slate-800 pt-2">
                    <summary className="text-slate-500 cursor-pointer hover:text-slate-300 font-bold uppercase tracking-wider text-[10px]">View Diagnostic Stack</summary>
                    <pre className="text-[10px] text-slate-600 mt-2 whitespace-pre-wrap pl-2 border-l-2 border-slate-700 overflow-x-auto">
                      {errorInfo.componentStack}
                    </pre>
                  </details>
                )}
              </div>

              <button
                onClick={this.handleReload}
                className="w-full py-4 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl shadow-lg shadow-red-900/30 transition-all active:scale-95 uppercase tracking-widest flex items-center justify-center gap-2 group"
              >
                <i className="fa-solid fa-power-off group-hover:animate-pulse"></i>
                Reboot Terminal
              </button>
            </div>
            <div className="bg-slate-950 p-3 text-center border-t border-slate-800">
              <p className="text-[10px] text-slate-600 font-mono uppercase tracking-widest">Error Code: 0xCRASH // Contact Admin if persistent</p>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;