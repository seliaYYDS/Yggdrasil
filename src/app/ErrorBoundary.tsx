import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onError?: (message: string) => void;
}

interface State {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info: info.componentStack ?? '' });
    this.props.onError?.(error.message);
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="ygg-error-panel">
        <div className="title">✕ {error.message}</div>
        {info ? <pre>{info.trim().split('\n').slice(0, 10).join('\n')}</pre> : null}
      </div>
    );
  }
}
