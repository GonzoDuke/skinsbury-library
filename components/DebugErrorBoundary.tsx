'use client';

import React from 'react';

/**
 * Catches client render errors and POSTs the unminified message + stack
 * to /api/debug-log so we can read it in the dev-server console. Mounted
 * around the page tree only when ?debug=1 is present, so production
 * traffic isn't affected.
 */
export class DebugErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; info: React.ErrorInfo | null }
> {
  state = { error: null as Error | null, info: null as React.ErrorInfo | null };

  static getDerivedStateFromError(error: Error) {
    return { error, info: null };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ error, info });
    fetch('/api/debug-log', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body:
        `MESSAGE: ${error.message}\n\n` +
        `STACK:\n${error.stack}\n\n` +
        `COMPONENT STACK:\n${info.componentStack ?? '(none)'}`,
    }).catch(() => {});
  }
  render() {
    if (this.state.error) {
      return (
        <pre style={{ padding: 20, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          <strong>Render crashed.</strong>
          {'\n\n'}
          {this.state.error.message}
          {'\n\n'}
          {this.state.info?.componentStack}
        </pre>
      );
    }
    return this.props.children;
  }
}
