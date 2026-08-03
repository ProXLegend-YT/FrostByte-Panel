import { StrictMode, Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Renders the actual error directly on screen instead of a silent blank
// page. This exists specifically so a crash is diagnosable from a phone
// with no browser dev tools available — the error text itself, not just
// "something broke", is what's shown.
function renderFatalError(title: string, detail: string) {
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = `
    <div style="min-height:100vh;background:#0a0e17;color:#f1f5f9;font-family:ui-monospace,monospace;padding:24px;box-sizing:border-box;">
      <div style="max-width:700px;margin:0 auto;">
        <h1 style="color:#fca5a5;font-size:1.1rem;margin-bottom:12px;">${title}</h1>
        <pre style="white-space:pre-wrap;word-break:break-word;background:#000;border:1px solid #ffffff22;border-radius:8px;padding:16px;font-size:0.8rem;line-height:1.5;color:#fca5a5;">${detail}</pre>
        <p style="color:#94a3b8;font-size:0.8rem;margin-top:16px;">Screenshot this and send it — it's the real error, not a guess.</p>
      </div>
    </div>
  `;
}

window.addEventListener('error', (event) => {
  renderFatalError('Uncaught error', `${event.message}\n\n${event.filename}:${event.lineno}:${event.colno}\n\n${event.error?.stack || ''}`);
});

window.addEventListener('unhandledrejection', (event) => {
  renderFatalError('Unhandled promise rejection', String(event.reason?.stack || event.reason));
});

class RootErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    renderFatalError('React render error', `${error.message}\n\n${error.stack || ''}\n\n${info.componentStack || ''}`);
  }
  render() {
    if (this.state.hasError) return null; // renderFatalError already replaced the DOM directly
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
