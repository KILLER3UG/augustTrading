
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ToastProvider } from './components/shared/Toast';
import ErrorBoundary from './components/shared/ErrorBoundary';
import { installNavModalityTracking } from './utils/navModality';
import { primeChatSessions } from './services/trade/chatSessions';

// Self-hosted fonts (offline-capable, no external CDN dependency)
// Geist for UI, JetBrains Mono for data. NO serif ships: the owner ruled
// (2026-10-22) that every serif face in the app — DM Serif Text for
// display/hero and Newsreader for the model's answer — goes to the normal UI
// face. `--font-serif` and `--font-reading` stay as roles in index.css so the
// four headings and the answer body keep their vocabulary, but both resolve to
// the sans stack, and a stray `font-serif` cannot resurrect a serif because
// Tailwind's own default is overridden there.
// @fontsource/inter imports removed (2026-09-16): Inter sat only as a
// fallback family string behind Geist Variable in --font-sans; the Geist
// variable font covers the UI stack.
import '@fontsource-variable/geist';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';

// --- Global Error Handlers ---
// Catch unhandled Promise rejections (common issue on Android WebView)
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Global] Unhandled Promise rejection:', event.reason);
  // Prevent the error from bubbling and causing a crash
  event.preventDefault();

  // Store for debugging
  try {
    const errorLog = {
      timestamp: new Date().toISOString(),
      type: 'unhandledrejection',
      message: event.reason?.message || String(event.reason),
      stack: event.reason?.stack
    };
    localStorage.setItem('lastPromiseError', JSON.stringify(errorLog));
  } catch (e) {
    // Ignore storage errors
  }
});

// Catch global JavaScript errors
window.addEventListener('error', (event) => {
  console.error('[Global] Uncaught error:', event.error);

  try {
    const errorLog = {
      timestamp: new Date().toISOString(),
      type: 'error',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    };
    localStorage.setItem('lastGlobalError', JSON.stringify(errorLog));
  } catch (e) {
    // Ignore storage errors
  }
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

// Which modality is allowed to paint a focus indicator, before anything mounts:
// the listeners are window-level and capture-phase, so a control that stops a
// keydown from bubbling still cannot hide that the mouse was used.
installNavModalityTracking();

// PRIME BEFORE THE FIRST PAINT. The dock's readers are synchronous and the desktop
// store is a JSON file behind IPC, so the bytes are fetched once here: one round
// trip on launch, and no flash of an empty transcript while a file read lands.
// On web this resolves immediately from localStorage, which is why it is awaited
// rather than branched on.
// Dead-store sweep: the removed sidebar flag (the dead prop the 2026-11-17
// audit found) left bytes in older profiles — one delete at boot, best-effort.
try { localStorage.removeItem('trade_sidebar_open_v1'); } catch { /* private mode */ }
void primeChatSessions().finally(() => {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
});

// Splash fade-out. The splash lives outside #root (index.html), so React's
// mount-clear leaves it alone and this owns its exit. The node must end up
// REMOVED, not merely hidden — e2e smoke and scripts/boot-probe.cjs both wait
// for #splash to be gone as the "boot completed" signal.
function dismissSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;
  splash.classList.add('splash-fading');
  window.setTimeout(() => splash.remove(), 300);
}
requestAnimationFrame(() => requestAnimationFrame(dismissSplash));
