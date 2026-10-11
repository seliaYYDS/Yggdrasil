import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { compileComponent } from './compile';
import { getSurfaceState, subscribeSurfaces } from '../kernel/registry/surfaceRegistry';
import { ErrorBoundary } from '../app/ErrorBoundary';

/**
 * 渲染一个界面插槽。
 * 若该插槽被 Agent 覆写过，就渲染它的组件；否则渲染 fallback（内置实现）。
 */
export function Surface({
  id,
  props,
  fallback,
}: {
  id: string;
  props?: Record<string, unknown>;
  fallback: ReactNode;
}) {
  const source = useSyncExternalStore(
    subscribeSurfaces,
    () => getSurfaceState(id)?.source ?? null,
    () => null,
  );

  const compiled = useMemo(
    () => (source ? compileComponent('surface_' + id, source) : null),
    [id, source],
  );

  if (!source || !compiled) return <>{fallback}</>;
  if (!compiled.ok) {
    return (
      <div className="ygg-error-panel">
        <div className="title">✕ {id}</div>
        <pre>{compiled.error}</pre>
      </div>
    );
  }

  const C = compiled.Component;
  return (
    <ErrorBoundary fallbackTitle={'插槽 ' + id + ' 运行时报错'}>
      <C {...(props ?? {})} />
    </ErrorBoundary>
  );
}
