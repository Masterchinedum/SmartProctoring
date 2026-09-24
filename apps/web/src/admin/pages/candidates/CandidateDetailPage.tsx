import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CandidateDTO, EvidenceRefDTO, IdPhotoUploadResponse } from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { useAuth } from '../../auth';
import { formatDateTime } from '../../lib/format';
import { ACCEPTED_IMAGE_TYPES, fileToJpeg } from '../../lib/image';
import { StatusBadge } from '../../components/Badges';
import { EmptyState, ErrorState, Loading, PageHeader } from '../../components/Common';
import { EvidenceImage } from '../../components/EvidenceImage';
import { Lightbox } from '../../components/Lightbox';
import { ConfirmDialog } from '../../components/Modal';
import { QualitySummary } from '../session/IdentityTab';
import { CandidateFormModal } from './CandidatesPage';

export function CandidateDetailPage() {
  const { id = '' } = useParams();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.candidate(id), queryFn: () => api.candidate(id), retry: shouldRetry });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const del = useMutation({
    mutationFn: () => api.deleteCandidate(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.candidatesAll });
      navigate('/admin/candidates');
    },
  });

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const c = q.data;

  return (
    <div className="stack">
      <PageHeader
        back={<Link to="/admin/candidates">← Candidates</Link>}
        title={c.name}
        subtitle={[c.email, c.externalId ? `ID ${c.externalId}` : null].filter(Boolean).join(' · ') || undefined}
        actions={
          isAdmin ? (
            <>
              <button type="button" className="btn" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
                Delete…
              </button>
            </>
          ) : null
        }
      />
      <div className="grid-2">
        <IdPhotoPanel candidate={c} canEdit={isAdmin} />
        <section className="card stack">
          <h2>Sessions</h2>
          {c.sessions.length === 0 ? (
            <EmptyState title="Not assigned to any exam">Assign this candidate from an exam’s page.</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Exam</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {c.sessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/admin/sessions/${s.id}`}>{s.examTitle}</Link>
                    </td>
                    <td>
                      <StatusBadge status={s.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="muted small">Added {formatDateTime(c.createdAt)}</div>
        </section>
      </div>
      {editing ? (
        <CandidateFormModal
          candidate={c}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={`Delete ${c.name}?`}
          message={
            <>
              The candidate and their ID photo are removed immediately. Deletion is refused while one of their sessions is in progress. Past session records follow the
              retention policy.
            </>
          }
          confirmLabel="Delete candidate"
          danger
          busy={del.isPending}
          error={del.isError ? errorMessage(del.error) : null}
          onConfirm={() => del.mutate()}
          onCancel={() => setDeleting(false)}
        />
      ) : null}
    </div>
  );
}

function IdPhotoPanel({ candidate: c, canEdit }: { candidate: CandidateDTO; canEdit: boolean }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<IdPhotoUploadResponse | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const upload = useMutation({
    mutationFn: (jpeg: Blob) => api.uploadIdPhoto(c.id, jpeg),
    onSuccess: (r) => {
      setResult(r);
      qc.setQueryData(qk.candidate(c.id), r.candidate);
      void qc.invalidateQueries({ queryKey: qk.candidatesAll });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeIdPhoto(c.id),
    onSuccess: (cand) => {
      setResult(null);
      setConfirmRemove(false);
      qc.setQueryData(qk.candidate(c.id), cand);
      void qc.invalidateQueries({ queryKey: qk.candidatesAll });
    },
  });

  const onFile = async (file: File | undefined) => {
    setLocalError(null);
    setResult(null);
    if (!file) return;
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setLocalError('Choose a JPEG, PNG or WebP image.');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setLocalError('This file is too large (max 25 MB before resizing).');
      return;
    }
    setPreparing(true);
    try {
      const { blob } = await fileToJpeg(file, 1280, 0.9);
      upload.mutate(blob);
    } catch (err) {
      setLocalError(errorMessage(err));
    } finally {
      setPreparing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const photo: EvidenceRefDTO | null = c.idPhoto
    ? { id: c.idPhoto.evidenceId, kind: 'id_photo', capturedAt: c.idPhoto.approvedAt, available: true, purgedAt: null, url: api.evidenceUrl(c.idPhoto.evidenceId) }
    : null;

  return (
    <section className="card stack">
      <h2>Approved ID photo</h2>
      <p className="muted small">
        Optional. When an exam enables ID-photo comparison, the live candidate is compared with this photo at check-in. The photo is encrypted at rest and every view
        is logged. Use a clear, front-facing, well-lit photo of the face (such as a passport-style photo).
      </p>
      {photo ? (
        <div className="row id-photo-row">
          <EvidenceImage evidence={photo} size="large" onOpen={() => setLightbox(true)} alt={`ID photo of ${c.name}`} />
          <div className="stack">
            <div className="small">Approved {formatDateTime(c.idPhoto!.approvedAt)}</div>
            {c.idPhoto!.quality ? <QualitySummary q={c.idPhoto!.quality} /> : null}
          </div>
        </div>
      ) : (
        <div className="muted">No ID photo on file.</div>
      )}
      {canEdit ? (
        <div className="row">
          <input ref={fileRef} type="file" accept={ACCEPTED_IMAGE_TYPES.join(',')} className="visually-hidden" id={`idphoto-${c.id}`} onChange={(e) => void onFile(e.target.files?.[0])} />
          <label htmlFor={`idphoto-${c.id}`} className={`btn btn-primary${preparing || upload.isPending ? ' disabled' : ''}`}>
            {preparing ? 'Preparing image…' : upload.isPending ? 'Uploading…' : photo ? 'Replace photo…' : 'Upload photo…'}
          </label>
          {photo ? (
            <button type="button" className="btn" onClick={() => setConfirmRemove(true)}>
              Remove photo
            </button>
          ) : null}
        </div>
      ) : null}
      {localError ? <div className="banner banner-danger">{localError}</div> : null}
      {upload.isError ? <div className="banner banner-danger">{errorMessage(upload.error)}</div> : null}
      {result ? (
        <div className={`banner ${result.accepted ? 'banner-success' : 'banner-warning'} stack`}>
          <strong>{result.accepted ? 'Photo accepted.' : 'Photo not accepted — the image is not suitable for dependable comparison.'}</strong>
          {result.guidance.length ? (
            <ul className="small">
              {result.guidance.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          ) : null}
          <QualitySummary q={result.quality} />
        </div>
      ) : null}
      {lightbox && photo ? <Lightbox items={[{ evidence: photo, caption: `ID photo — ${c.name}` }]} index={0} onClose={() => setLightbox(false)} /> : null}
      {confirmRemove ? (
        <ConfirmDialog
          title="Remove the ID photo?"
          message="The photo and its face template are deleted. Exams that require ID-photo comparison will no longer compare this candidate."
          confirmLabel="Remove photo"
          danger
          busy={remove.isPending}
          error={remove.isError ? errorMessage(remove.error) : null}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirmRemove(false)}
        />
      ) : null}
    </section>
  );
}
