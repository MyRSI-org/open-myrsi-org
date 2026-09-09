import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { installAvatarFallback } from './lib/avatarFallback';
import { printConsoleBanner } from './lib/consoleBanner';

// Vite fires an event when a dynamic import (React.lazy) fails to preload — the stale-chunk
// case after a deploy.
//
// A listener here used to suppress that event's default, and that single line made EVERY
// chunk-recovery path in the app dead code. Vite's helper is:
//
//     window.dispatchEvent(e);
//     if (!e.defaultPrevented) throw err;
//     ...
//     return baseModule().catch(handlePreloadError);
//
// so suppressing the default meant the handler RETURNED instead of throwing, and the failed
// import RESOLVED with `undefined` rather than rejecting. Nothing downstream could see a
// failure: App.tsx's and DashboardApp.tsx's lazyWithRetry `.catch` never fired, pwa-init.js's
// unhandledrejection recovery never fired (no rejection was ever raised), and React then read
// `.default` off undefined and threw a TypeError — which is how a routine redeploy reached the
// user as a red "System Critical" screen instead of a retry or a reload prompt.
//
// Deliberately NOT re-registered as a no-op listener: letting the error propagate is the whole
// point. lazyWithRetry (retry once, then one hard reload) owns recovery from here, and the
// build-id watcher offers a reload before the user ever navigates into a missing chunk.

installAvatarFallback();
printConsoleBanner();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
