import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { request, errorMessage } from '../api/client';
import { useAuth } from '../auth';
import { formatDateTime, formatPercent, formatSimilarity, humanizeKey } from '../lib/format';
import { KeyValueTable } from '../components/Common';

/**
 * Offline accuracy evaluation reports (stored by POST /api/admin/metrics/offline-evaluation and returned
 * in DetectionQualityDTO.offlineEvaluation as { reports: [{ id, kind, createdAt, global, report }] }).
 * Identity reports (eval:identity) get a dedicated per-condition view; anything else is rendered generically.
 */

interface OfflineEntry {
  id?: string;
  kind?: string;
  createdAt?: number;
  global?: boolean;
  report: unknown;
}

interface Rates {
  n: number;
  rates?: Record<string, number>;
  falseMismatchRate?: number;
  falseMismatchRateUsable?: number;
  falseMatchRate?: number;
  detectionRate?: number;
  similarity?: { median: number | null; p05: number | null; p95: number | null };
}

interface IdentityGroup {
  group: string;
  description?: string;
  genuine: Rates;
  impostor: Rates;
  topIssues?: { issue: string; count: number }[];
  eer?: { eer: number; threshold: number } | null;
  events?: {
    falseMismatchEventsPerHourIndependent?: number;
    falseMismatchEventProbabilityCorrelated?: number;
    swapDetectedWithin?: { samples: number; minutes: number; probability: number }[];
    swapFlaggedWithin?: { samples: number; minutes: number; probability: number }[];
    assumption?: string;
  };
}

interface IdentityReport {
  generatedAt?: string;
  tool?: string;
  mode?: string;
  model?: { detector?: string; embedder?: string };
  thresholds?: Record<string, number>;
  dataset?: Record<string, unknown>;
  groups: IdentityGroup[];
  notes?: string[];
}

export function isIdentityReport(r: unknown): r is IdentityReport {
  if (!r || typeof r !== 'object') return false;
  const g = (r as { groups?: unknown }).groups;
  return Array.isArray(g) && g.length > 0 && typeof g[0] === 'object' && g[0] !== null && 'genuine' in g[0] && 'impostor' in g[0];
}

/** Normalises the stored value into a list of reports. */
export function offlineEntries(value: unknown): OfflineEntry[] {
  if (value == null) return [];
  if (typeof value === 'object' && Array.isArray((value as { reports?: unknown }).reports)) {
    return ((value as { reports: OfflineEntry[] }).reports ?? []).filter((e) => e && typeof e === 'object' && 'report' in e);
  }
  return [{ report: value }];
}

export function OfflineEvaluationSection({ value }: { value: unknown }) {
  const { isAdmin } = useAuth();
  const entries = offlineEntries(value);
  return (
    <section className="card stack">
      <div className="row">
        <h2>Offline evaluation</h2>
        <div className="spacer" />
        {isAdmin ? <UploadReport /> : null}
      </div>
      {entries.length === 0 ? (
        <div className="muted">
          No offline evaluation report has been stored yet. Run <code>pnpm --filter @sp/server eval:identity --out report.json</code> on a consented, labelled dataset
          (lighting, cameras, glasses, hairstyles, clothing, backgrounds, pause lengths) and upload the JSON here before launch.
        </div>
      ) : (
        entries.map((e, i) => (
          <div key={e.id ?? i} className="stack offline-report">
            <div className="small muted">
              <strong>{e.kind ? reportKindLabel(e.kind) : 'Report'}</strong>
              {e.createdAt ? <> · uploaded {formatDateTime(e.createdAt)}</> : null}
              {e.global ? ' · shipped with this release' : null}
            </div>
            {isIdentityReport(e.report) ? <IdentityReportView r={e.report} /> : <GenericReport value={e.report} />}
          </div>
        ))
      )}
    </section>
  );
}

function UploadReport() {
  const qc = useQueryClient();
  const ref = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: async (file: File) => {
      let json: unknown;
      try {
        json = JSON.parse(await file.text());
      } catch {
        throw new Error('This file is not valid JSON.');
      }
      return request<{ id: string; kind: string; createdAt: number }>('POST', '/api/admin/metrics/offline-evaluation', { body: json });
    },
    onSuccess: (r) => {
      setMsg(`Uploaded: ${reportKindLabel(r.kind)}.`);
      void qc.invalidateQueries({ queryKey: ['quality'] });
    },
    onError: (err) => setMsg(errorMessage(err)),
  });
  return (
    <div className="row">
      {msg ? <span className={m.isError ? 'text-danger small' : 'text-success small'}>{msg}</span> : null}
      <input
        ref={ref}
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        id="offline-report-file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) m.mutate(f);
          e.target.value = '';
        }}
      />
      <label htmlFor="offline-report-file" className={`btn btn-sm${m.isPending ? ' disabled' : ''}`}>
        {m.isPending ? 'Uploading…' : 'Upload report (JSON)…'}
      </label>
    </div>
  );
}

/** "apps/server/src/eval/identity-eval.ts" or "identity-eval" -> "Identity verification accuracy". */
export function reportKindLabel(kind: string): string {
  const base = (kind.split(/[\\/]/).pop() ?? kind).replace(/\.(c|m)?[tj]s$/, '');
  if (/identity/i.test(base)) return 'Identity verification accuracy';
  if (/detect|scenario|behaviou?r/i.test(base)) return 'Behaviour detector accuracy';
  return humanizeKey(base);
}

const pct = (v: number | undefined | null) => (v == null ? '—' : formatPercent(v, 1));

function IdentityReportView({ r }: { r: IdentityReport }) {
  const all = r.groups.find((g) => g.group === 'all') ?? r.groups[0];
  const ev = all?.events;
  return (
    <div className="stack">
      <div className="grid-2">
        <KeyValueTable
          rows={[
            ['Generated', r.generatedAt ? formatDateTime(Date.parse(r.generatedAt)) : '—'],
            ['Mode', r.mode ?? '—'],
            ['Model', r.model ? `${r.model.detector ?? ''} + ${r.model.embedder ?? ''}` : '—'],
            ['Thresholds', r.thresholds ? `match ≥ ${formatSimilarity(r.thresholds.match)}, mismatch < ${formatSimilarity(r.thresholds.mismatch)}` : '—'],
          ]}
        />
        <KeyValueTable data={r.dataset ?? {}} />
      </div>
      {ev ? (
        <div className="stats-row">
          <div className="stat">
            <div className="stat-value">{ev.falseMismatchEventsPerHourIndependent != null ? ev.falseMismatchEventsPerHourIndependent.toFixed(3) : '—'}</div>
            <div className="stat-label">Expected false “possible different person” events per candidate-hour</div>
          </div>
          {ev.swapDetectedWithin?.slice(0, 3).map((s) => (
            <div key={s.samples} className="stat">
              <div className="stat-value">{formatPercent(s.probability)}</div>
              <div className="stat-label">Swap detected within {s.minutes} min</div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Condition</th>
              <th title="Genuine probes (same person)">Genuine n</th>
              <th title="Same person decided 'possible different person' — the critical error">False mismatch</th>
              <th title="Same person: image not usable">Could not verify</th>
              <th title="Impostor probes (different person)">Impostor n</th>
              <th title="Different person decided 'same person' — a missed swap">False match</th>
              <th title="Different person decided 'possible different person' per sample">Swap detected / sample</th>
              <th>Genuine similarity (p05–median)</th>
              <th>Top quality issues</th>
            </tr>
          </thead>
          <tbody>
            {r.groups.map((g) => (
              <tr key={g.group}>
                <td title={g.description}>
                  <strong>{humanizeKey(g.group)}</strong>
                </td>
                <td>{g.genuine.n}</td>
                <td className={g.genuine.falseMismatchRate ? 'text-danger' : ''}>{pct(g.genuine.falseMismatchRate)}</td>
                <td>{pct(g.genuine.rates?.unable_to_verify)}</td>
                <td>{g.impostor.n}</td>
                <td className={g.impostor.falseMatchRate ? 'text-danger' : ''}>{pct(g.impostor.falseMatchRate)}</td>
                <td>{pct(g.impostor.detectionRate)}</td>
                <td>
                  {formatSimilarity(g.genuine.similarity?.p05)}–{formatSimilarity(g.genuine.similarity?.median)}
                </td>
                <td className="small">{g.topIssues?.length ? g.topIssues.map((t) => `${humanizeKey(t.issue)} (${t.count})`).join(', ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted small">
        False mismatch = the same person was judged a possible different person (the error that wrongly holds genuine candidates). False match = a different person was
        accepted (a missed swap). “Could not verify” outcomes route to human review and are never counted as mismatches.
      </div>
      {ev?.assumption ? <div className="muted small">Event estimates: {ev.assumption}</div> : null}
      {r.notes?.length ? (
        <ul className="small">
          {r.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary className="small">Raw report</summary>
        <pre className="kv-json">{JSON.stringify(r, null, 2)}</pre>
      </details>
    </div>
  );
}

/** Renders an arbitrary evaluation report: scalars as key/values, arrays of objects as tables. */
export function GenericReport({ value }: { value: unknown }) {
  if (value == null || typeof value !== 'object') return <div>{String(value)}</div>;
  const entries = Object.entries(value as Record<string, unknown>);
  const scalars = Object.fromEntries(entries.filter(([, v]) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => typeof x !== 'object'))));
  const tables = entries.filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) as [string, Record<string, unknown>[]][];
  const objects = entries.filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)) as [string, Record<string, unknown>][];
  return (
    <div className="stack">
      {Object.keys(scalars).length ? <KeyValueTable data={scalars} /> : null}
      {objects.map(([k, v]) => (
        <div key={k}>
          <h4>{humanizeKey(k)}</h4>
          <GenericReport value={v} />
        </div>
      ))}
      {tables.map(([k, rows]) => {
        const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => rows.some((r) => r[c] === null || typeof r[c] !== 'object'));
        return (
          <div key={k} className="table-wrap">
            <h4>{humanizeKey(k)}</h4>
            <table className="table compact">
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c}>{humanizeKey(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {cols.map((c) => (
                      <td key={c}>{formatCell(c, r[c])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function formatCell(key: string, v: unknown): string {
  if (typeof v === 'number') {
    if (/(rate|fmr|fnmr|precision|recall|share|probability)/i.test(key) && v >= 0 && v <= 1) return formatPercent(v, 1);
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
