import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NoteDTO, SessionDetailDTO } from '@sp/shared';
import { api, errorMessage } from '../../api/client';
import { qk } from '../../api/queries';
import { useNow } from '../../lib/clock';
import { formatDateTime, formatDuration } from '../../lib/format';
import { PERIOD_LABELS } from '../../lib/labels';
import { periodDurationMs } from '../../lib/timeline';
import { EmptyState, KeyValueTable } from '../../components/Common';
import { NoteList } from '../../components/EventDetail';
import { LiveDuration } from '../../components/Time';

export function PeriodsTab({ d }: { d: SessionDetailDTO }) {
  const now = useNow(d.periods.some((p) => p.endedAt == null));
  const periods = [...d.periods].sort((a, b) => a.startedAt - b.startedAt);
  if (!periods.length) return <EmptyState title="No periods yet">Periods begin when the candidate starts the readiness check.</EmptyState>;
  const observed = periods.filter((p) => p.observed).reduce((n, p) => n + periodDurationMs(p, now), 0);
  const unobserved = periods.filter((p) => !p.observed).reduce((n, p) => n + periodDurationMs(p, now), 0);
  return (
    <div className="stack">
      <div className="row">
        <span className="badge badge-success">Observed {formatDuration(observed)}</span>
        <span className="badge">Unobserved {formatDuration(unobserved)}</span>
        <span className="muted small">Unobserved periods (paused, disconnected, on hold) carry no behavioural observations by design.</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Period</th>
              <th>Monitoring</th>
              <th>Start</th>
              <th>End</th>
              <th>Duration</th>
              <th>Reason / details</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p, i) => (
              <tr key={p.id} className={p.observed ? 'row-observed' : 'row-unobserved'}>
                <td>{i + 1}</td>
                <td>
                  <strong>{PERIOD_LABELS[p.kind] ?? p.kind}</strong>
                </td>
                <td>{p.observed ? <span className="badge badge-success">Observed</span> : <span className="badge">Unobserved</span>}</td>
                <td className="nowrap">{formatDateTime(p.startedAt)}</td>
                <td className="nowrap">{p.endedAt ? formatDateTime(p.endedAt) : <span className="ongoing-tag">ongoing</span>}</td>
                <td className="nowrap">
                  <LiveDuration from={p.startedAt} to={p.endedAt} ongoingLabel={false} />
                </td>
                <td className="small">
                  {p.reason ? <div>{p.reason}</div> : null}
                  {Object.keys(p.meta ?? {}).length ? <KeyValueTable data={p.meta} /> : !p.reason ? <span className="muted">—</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DevicesTab({ d }: { d: SessionDetailDTO }) {
  const devices = [...d.devices].sort((a, b) => a.at - b.at);
  if (!devices.length) return <EmptyState title="No device records yet">Recorded at each readiness, resume and reconnect check.</EmptyState>;
  return (
    <div className="stack">
      <div className="muted small">
        A camera or browser change is recorded as context and is not a violation by itself. Camera ids are stored only as a hash.
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Check</th>
              <th>Camera</th>
              <th>Browser instance</th>
              <th>User agent</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((dev, i) => {
              const prev = devices[i - 1];
              const cameraChanged = prev && prev.cameraIdHash !== dev.cameraIdHash;
              const instanceChanged = prev && prev.clientInstanceId !== dev.clientInstanceId;
              const uaChanged = prev && prev.userAgent !== dev.userAgent;
              return (
                <tr key={`${dev.at}-${i}`}>
                  <td className="nowrap">{formatDateTime(dev.at)}</td>
                  <td>{dev.purpose}</td>
                  <td>
                    {dev.cameraLabel || <span className="muted">(no label)</span>}
                    <div className="muted small mono" title={dev.cameraIdHash}>
                      {dev.cameraIdHash ? `#${dev.cameraIdHash.slice(0, 10)}` : ''}
                    </div>
                    {cameraChanged ? <span className="badge badge-neutral">Camera changed</span> : null}
                  </td>
                  <td>
                    <span className="mono small" title={dev.clientInstanceId}>
                      {dev.clientInstanceId.slice(0, 8)}
                    </span>
                    {instanceChanged ? (
                      <div>
                        <span className="badge badge-neutral">New browser instance</span>
                      </div>
                    ) : null}
                  </td>
                  <td className="small ua-cell" title={dev.userAgent}>
                    {dev.userAgent || <span className="muted">—</span>}
                    {uaChanged ? (
                      <div>
                        <span className="badge badge-neutral">Different browser/device</span>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function NotesTab({ d, onOpenEvent }: { d: SessionDetailDTO; onOpenEvent: (id: string) => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const m = useMutation({
    mutationFn: () => api.addSessionNote(d.summary.id, text.trim()),
    onSuccess: (note: NoteDTO) => {
      qc.setQueryData<SessionDetailDTO>(qk.session(d.summary.id), (old) => (old ? { ...old, notes: [...old.notes, note] } : old));
      setText('');
    },
  });
  return (
    <div className="stack notes-tab">
      <NoteList
        notes={d.notes}
        empty="No notes on this session yet."
        showEventLink={(eventId) => (
          <button type="button" className="link-btn" onClick={() => onOpenEvent(eventId)}>
            on an event
          </button>
        )}
      />
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) m.mutate();
        }}
      >
        <label>
          Add a session note
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} rows={3} placeholder="Notes are visible to all staff and included in the report." />
        </label>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={!text.trim() || m.isPending}>
            {m.isPending ? 'Adding…' : 'Add note'}
          </button>
          {m.isError ? <span className="text-danger small">{errorMessage(m.error)}</span> : null}
        </div>
      </form>
    </div>
  );
}
