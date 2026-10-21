import { ACCOMMODATION_CATALOG, STAFF_VERIFICATION_METHOD_LABEL, type SessionAccommodationsDTO, type StaffVerificationDTO } from '@sp/shared';
import { formatExceptionValue } from '../lib/accommodations';
import { formatDateTime, formatDuration } from '../lib/format';

/**
 * A session's approved accommodations and every exam rule they changed — what a reviewer needs to read the session
 * correctly (an observation turned off is absent by design, not because nothing happened). Also the staff identity
 * verifications when identity is verified by staff.
 */
export function AccommodationsCard({ acc, verifications, started }: { acc: SessionAccommodationsDTO | null; verifications: StaffVerificationDTO[]; started: boolean }) {
  if (!acc && !verifications.length) return null;
  return (
    <section className="card stack accommodations-card" aria-labelledby="session-acc-title" data-testid="session-accommodations">
      <h2 id="session-acc-title">{acc ? 'Approved accommodations' : 'Identity verified by staff'}</h2>
      {acc ? (
        <>
          <ul className="changed-list">
            {acc.items.map((i) => (
              <li key={i.id}>
                <strong>{i.label}</strong> <span className="muted small">— {ACCOMMODATION_CATALOG[i.kind].description}</span>
              </li>
            ))}
          </ul>
          <details open>
            <summary className="small">
              Exam rules changed for this candidate ({acc.exceptions.length}){started ? '' : ' — final when the exam starts'}
            </summary>
            <table className="table compact exceptions-table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Exam</th>
                  <th>This candidate</th>
                </tr>
              </thead>
              <tbody>
                {acc.exceptions.map((e) => (
                  <tr key={e.path}>
                    <td>{e.label}</td>
                    <td className="muted">{formatExceptionValue(e, e.from)}</td>
                    <td>
                      <strong>{formatExceptionValue(e, e.to)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {acc.extraTimeMs > 0 ? <div className="small muted">Extra time included in the duration: {formatDuration(acc.extraTimeMs)}.</div> : null}
          </details>
        </>
      ) : null}
      {verifications.length ? (
        <div className="small">
          <strong>Identity verified by staff:</strong>{' '}
          {verifications.map((v, n) => (
            <span key={v.at}>
              {n ? '; ' : ''}
              {formatDateTime(v.at)} — {STAFF_VERIFICATION_METHOD_LABEL[v.method].toLowerCase()}
              {v.by ? `, ${v.by.name}` : ''}
              {v.purpose && v.purpose !== 'initial' ? ` (after a ${v.purpose === 'resume' ? 'pause' : v.purpose === 'reconnect' ? 'reconnection' : 'hold'})` : ''}
              {v.note ? ` — “${v.note}”` : ''}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
