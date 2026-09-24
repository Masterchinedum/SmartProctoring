import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { IDENTITY_DECISIONS, LIVENESS_INSTRUCTIONS, type FaceQuality, type IdentityReferenceDTO, type SessionDetailDTO } from '@sp/shared';
import { api, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { formatDateTime, formatNumber, formatPercent, formatSimilarity } from '../../lib/format';
import { contextLabel, DECISION_HELP, DECISION_LABELS, PERIOD_LABELS, qualityIssueLabel, TRIGGER_LABELS } from '../../lib/labels';
import { DecisionBadge } from '../../components/Badges';
import { EmptyState } from '../../components/Common';
import { EvidenceGallery } from '../../components/EventDetail';
import { EvidenceImage } from '../../components/EvidenceImage';
import { Lightbox } from '../../components/Lightbox';
import { Clock } from '../../components/Time';

export function IdentityTab({ d, onOpenEvent }: { d: SessionDetailDTO; onOpenEvent: (id: string) => void }) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const checks = useMemo(() => [...d.identityChecks].sort((a, b) => a.at - b.at), [d.identityChecks]);
  const withImages = checks.filter((c) => c.probeEvidence);
  const counts = useMemo(() => {
    const c = Object.fromEntries(IDENTITY_DECISIONS.map((x) => [x, 0])) as Record<(typeof IDENTITY_DECISIONS)[number], number>;
    for (const ch of checks) c[ch.decision]++;
    return c;
  }, [checks]);
  const references = [...d.references].sort((a, b) => Number(b.active) - Number(a.active) || a.createdAt - b.createdAt);

  // Identity events for "Compare images" links.
  const events = useQuery({ queryKey: qk.sessionEvents(d.summary.id), queryFn: () => api.sessionEvents(d.summary.id), retry: shouldRetry });
  const identityEvents = (events.data?.items ?? []).filter((e) => e.type === 'identity_mismatch' || e.type === 'identity_unverifiable');

  return (
    <div className="stack identity-tab">
      <div className="guidance">
        <div className="guidance-title">How identity continuity works</div>A protected reference is established from the candidate’s face at check-in (after a live-person check). Every later
        sample — after a pause, a camera interruption, the face leaving and returning, and routinely during the exam — is compared with that original reference. The
        reference is never replaced automatically; only staff can authorise a re-enrolment. <strong>“Could not verify”</strong> means the image was not usable and is{' '}
        <strong>not</strong> evidence of a different person.
      </div>

      {identityEvents.length ? (
        <div className="card">
          <h3>Identity events</h3>
          <ul className="plain-list">
            {identityEvents.map((e) => (
              <li key={e.id} className="row">
                <span className={`badge badge-${e.category}`}>{e.title}</span>
                <Clock at={e.startedAt} />
                <button type="button" className="link-btn" onClick={() => onOpenEvent(e.id)}>
                  Details
                </button>
                <Link to={`/admin/sessions/${d.summary.id}/compare/${e.id}`} className="btn btn-sm btn-primary">
                  Compare images
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <section>
        <h2>Identity reference{references.length > 1 ? 's' : ''}</h2>
        {references.length === 0 ? (
          <EmptyState title="No identity reference yet">It is established when the candidate completes the readiness check.</EmptyState>
        ) : (
          <div className="stack">
            {references.map((r) => (
              <ReferenceCard key={r.id} r={r} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>Identity checks</h2>
        <div className="row decision-summary">
          {IDENTITY_DECISIONS.map((dec) => (
            <span key={dec} className="decision-count" title={DECISION_HELP[dec]}>
              <DecisionBadge decision={dec} /> <strong>{counts[dec]}</strong>
            </span>
          ))}
        </div>
        {checks.length === 0 ? (
          <div className="muted">No identity checks yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Trigger</th>
                  <th>Decision</th>
                  <th>Similarity</th>
                  <th>Image quality</th>
                  <th>Context</th>
                  <th>Sample</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.id} className={`row-decision-${c.decision}`}>
                    <td className="nowrap">
                      <Clock at={c.at} />
                    </td>
                    <td>{TRIGGER_LABELS[c.trigger] ?? c.trigger}</td>
                    <td>
                      <DecisionBadge decision={c.decision} livenessFailed={c.livenessPassed === false} />
                      <div className="muted small">confidence {formatPercent(c.confidence)}</div>
                      {c.secondOpinion ? (
                        <div className="small second-opinion" title={`Outcome: ${c.secondOpinion.outcome}`}>
                          {c.secondOpinion.needsHumanReview ? <span className="badge badge-warning">Opinions disagree — review</span> : null}
                          <div className="muted">
                            Second opinion{c.secondOpinion.provider ? ` (${c.secondOpinion.provider})` : ''}
                            {c.secondOpinion.externalSimilarity != null ? `: similarity ${formatPercent(c.secondOpinion.externalSimilarity)}` : ''}
                            {c.secondOpinion.internalDecision !== c.decision ? ` · own engine said: ${DECISION_LABELS[c.secondOpinion.internalDecision] ?? c.secondOpinion.internalDecision}` : ''}
                          </div>
                          {c.secondOpinion.explanation ? <div>{c.secondOpinion.explanation}</div> : null}
                        </div>
                      ) : null}
                    </td>
                    <td>{formatSimilarity(c.similarity)}</td>
                    <td>
                      {c.quality ? (
                        c.quality.issues.length ? (
                          <div className="chips-wrap">
                            {c.quality.issues.map((i) => (
                              <span key={i} className="chip static small">
                                {qualityIssueLabel(i)}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="muted small">Usable</span>
                        )
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                    <td className="small">
                      {c.context.precededBy.length ? c.context.precededBy.map(contextLabel).join(' · ') : <span className="muted">—</span>}
                      {c.context.periodKind ? <div className="muted">During: {PERIOD_LABELS[c.context.periodKind]}</div> : null}
                      {c.context.secondsSincePreviousMatch != null ? (
                        <div className="muted">{formatNumber(c.context.secondsSincePreviousMatch, 0)} s since previous match</div>
                      ) : null}
                    </td>
                    <td>
                      {c.probeEvidence ? (
                        <EvidenceImage
                          evidence={c.probeEvidence}
                          size="thumb"
                          onOpen={() => setLightbox(withImages.indexOf(c))}
                          context={`identity check (${TRIGGER_LABELS[c.trigger] ?? c.trigger}), ${DECISION_LABELS[c.decision] ?? c.decision}`}
                        />
                      ) : (
                        <span className="muted small" title="Images of routine matching samples are not kept (data minimisation)">
                          not kept
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {lightbox != null ? (
        <Lightbox
          items={withImages.map((c) => ({
            evidence: c.probeEvidence!,
            caption: `${TRIGGER_LABELS[c.trigger]} — ${DECISION_LABELS[c.decision]}${c.similarity != null ? ` (similarity ${formatSimilarity(c.similarity)})` : ''}`,
          }))}
          index={lightbox}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}

function ReferenceCard({ r }: { r: IdentityReferenceDTO }) {
  return (
    <div className={`card reference-card${r.active ? ' active' : ' superseded'}`}>
      <div className="row">
        <strong>Reference established {formatDateTime(r.createdAt)}</strong>
        {r.active ? <span className="badge badge-success">Active</span> : <span className="badge">Superseded</span>}
      </div>
      {!r.active ? (
        <div className="small muted">
          Superseded {r.supersededAt ? formatDateTime(r.supersededAt) : ''}
          {r.supersededReason ? <> — {r.supersededReason}</> : null}
        </div>
      ) : null}
      <div className="grid-2 reference-grid">
        <div>
          <h4>Reference images</h4>
          <EvidenceGallery evidence={r.images} emptyText="No reference images stored." captions={r.images.map(() => 'Identity reference')} />
        </div>
        <div className="stack">
          <div>
            <h4>Live-person check</h4>
            {r.liveness ? (
              <>
                <div>{r.liveness.passed ? <span className="badge badge-success">Passed</span> : <span className="badge badge-warning">Not passed</span>}</div>
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Action</th>
                      <th>Result</th>
                      <th>Measured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.liveness.steps.map((st) => (
                      <tr key={st.index}>
                        <td>{st.index + 1}</td>
                        <td>{LIVENESS_INSTRUCTIONS[st.action] ?? st.action}</td>
                        <td>
                          {st.passed ? <span className="badge badge-success">OK</span> : <span className="badge badge-warning">Not satisfied</span>}
                          {st.reason ? <div className="muted small">{st.reason}</div> : null}
                        </td>
                        <td>{st.measured != null ? `${formatNumber(st.measured, 0)}°` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {r.liveness.reasons.length ? <div className="small muted">{r.liveness.reasons.join(' · ')}</div> : null}
              </>
            ) : (
              <div className="muted small">Not performed (liveness check off for this exam).</div>
            )}
          </div>
          <div>
            <h4>ID-photo comparison</h4>
            {r.idPhoto ? (
              <div>
                <DecisionBadge decision={r.idPhoto.decision} />
                {r.idPhoto.similarity != null ? <span className="muted small"> similarity {formatSimilarity(r.idPhoto.similarity)}</span> : null}
                {r.idPhoto.decision === 'unable_to_verify' ? <div className="muted small">The images could not be compared dependably; this is not evidence of a different person.</div> : null}
              </div>
            ) : (
              <div className="muted small">Not compared (no approved ID photo, or comparison off).</div>
            )}
          </div>
          {r.quality ? (
            <div>
              <h4>Image quality at check-in</h4>
              <QualitySummary q={r.quality} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function QualitySummary({ q }: { q: FaceQuality }) {
  return (
    <div className="small quality-summary">
      <div>
        {q.usable ? <span className="badge badge-success">Usable</span> : <span className="badge badge-uncertain">Not usable</span>}{' '}
        {q.issues.map((i) => (
          <span key={i} className="chip static small">
            {qualityIssueLabel(i)}
          </span>
        ))}
      </div>
      <div className="muted">
        {q.faceCount} face{q.faceCount === 1 ? '' : 's'} · detection {formatPercent(q.detectionScore)} · eye distance {formatNumber(q.interEyePx, 0)} px · brightness{' '}
        {formatNumber(q.brightness, 0)} · sharpness {formatNumber(q.sharpness, 0)} · yaw {formatNumber(q.yawDeg, 0)}° · pitch {formatNumber(q.pitchDeg, 0)}°
        {q.cutOff ? ' · cut off' : ''}
      </div>
    </div>
  );
}
