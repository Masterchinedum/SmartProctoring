import { useState, type ReactNode } from 'react';
import { announce } from '../../lib/a11y';
import { errorMessage } from '../api/client';
import { formatDetailValue, humanizeKey } from '../lib/format';
import { describeDetailValue } from '../lib/labels';

export function EmptyState({ title, children, icon = '○' }: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden>
        {icon}
      </div>
      <div className="empty-title">{title}</div>
      {children ? <div className="muted">{children}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load this data' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="banner banner-danger error-state" role="alert">
      <div>
        <strong>{title}.</strong> {errorMessage(error)}
      </div>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden /> {label}
    </div>
  );
}

/** Two-column key/value table. Accepts a record (keys humanized, values formatted by key) or explicit rows. */
export function KeyValueTable({
  data,
  rows,
  empty = 'No details recorded.',
}: {
  data?: Record<string, unknown> | null;
  rows?: [ReactNode, ReactNode][];
  empty?: string;
}) {
  const list: [ReactNode, ReactNode][] =
    rows ?? Object.entries(data ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [humanizeKey(k), <ValueCell key={k} k={k} v={v} />]);
  if (list.length === 0) return <div className="muted small">{empty}</div>;
  return (
    <table className="kv-table">
      <tbody>
        {list.map(([k, v], i) => (
          <tr key={i}>
            <th scope="row">{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ValueCell({ k, v }: { k: string; v: unknown }) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length <= 8 && entries.every(([, x]) => x === null || typeof x !== 'object')) {
      return (
        <span className="kv-inline">
          {entries.map(([ik, iv]) => (
            <span key={ik}>
              <span className="muted">{humanizeKey(ik)}:</span> {describeDetailValue(ik, iv) ?? formatDetailValue(ik, iv)}
            </span>
          ))}
        </span>
      );
    }
    return <pre className="kv-json">{JSON.stringify(v, null, 2)}</pre>;
  }
  return <>{describeDetailValue(k, v) ?? formatDetailValue(k, v)}</>;
}

export function CopyButton({ text, label = 'Copy', className = 'btn btn-sm' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-secure contexts.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* ignore */
      }
      ta.remove();
    }
    setCopied(true);
    announce('Copied to the clipboard.', 'polite');
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className={className} onClick={copy} title={text}>
      {copied ? 'Copied ✓' : label}
    </button>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="page-header-main">
        {back ? <div className="page-back">{back}</div> : null}
        <h1>{title}</h1>
        {subtitle ? <div className="muted">{subtitle}</div> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'danger' | 'warning' | 'success' | 'info'; hint?: string }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`} title={hint}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function Pager({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit && offset === 0) return <div className="muted small pager-info">{total} total</div>;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(total, offset + limit);
  return (
    <div className="pager">
      <span className="muted small">
        {from}–{to} of {total}
      </span>
      <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        <span aria-hidden>‹</span> Previous
      </button>
      <button type="button" className="btn btn-sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        Next <span aria-hidden>›</span>
      </button>
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="banner banner-danger" role="alert">
      {errorMessage(error)}
    </div>
  );
}
