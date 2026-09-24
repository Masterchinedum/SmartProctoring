import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CandidateDTO } from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { useAuth } from '../../auth';
import { formatDate } from '../../lib/format';
import { EmptyState, ErrorState, Loading, PageHeader } from '../../components/Common';
import { Modal } from '../../components/Modal';

export function CandidatesPage() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const list = useQuery({ queryKey: qk.candidates(q), queryFn: () => api.candidates(q || undefined), placeholderData: keepPreviousData, retry: shouldRetry });

  return (
    <div className="stack">
      <PageHeader
        title="Candidates"
        subtitle="People who can be assigned to exams. An approved ID photo enables optional comparison at check-in."
        actions={
          isAdmin ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              Add candidate
            </button>
          ) : null
        }
      />
      <div className="filter-bar">
        <input type="text" className="grow" placeholder="Search by name, email or external ID…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search candidates" />
      </div>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState title={q ? 'No candidates match' : 'No candidates yet'}>{!q && isAdmin ? 'Add a candidate, then assign them to a published exam.' : null}</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table table-clickable">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>External ID</th>
                <th>ID photo</th>
                <th>Sessions</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((c) => (
                <tr key={c.id} onClick={() => navigate(`/admin/candidates/${c.id}`)}>
                  <td>
                    <Link to={`/admin/candidates/${c.id}`} onClick={(e) => e.stopPropagation()}>
                      <strong>{c.name}</strong>
                    </Link>
                  </td>
                  <td>{c.email ?? <span className="muted">—</span>}</td>
                  <td>{c.externalId ?? <span className="muted">—</span>}</td>
                  <td>{c.idPhoto ? <span className="badge badge-success">Approved</span> : <span className="muted small">None</span>}</td>
                  <td>{c.sessions.length}</td>
                  <td className="small">{formatDate(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating ? (
        <CandidateFormModal
          onClose={() => setCreating(false)}
          onSaved={(c) => {
            setCreating(false);
            navigate(`/admin/candidates/${c.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

export function CandidateFormModal({ candidate, onClose, onSaved }: { candidate?: CandidateDTO; onClose: () => void; onSaved: (c: CandidateDTO) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(candidate?.name ?? '');
  const [email, setEmail] = useState(candidate?.email ?? '');
  const [externalId, setExternalId] = useState(candidate?.externalId ?? '');
  const emailValid = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const m = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), email: email.trim() || null, externalId: externalId.trim() || null };
      return candidate ? api.updateCandidate(candidate.id, input) : api.createCandidate(input);
    },
    onSuccess: (c) => {
      qc.setQueryData(qk.candidate(c.id), c);
      void qc.invalidateQueries({ queryKey: qk.candidatesAll });
      onSaved(c);
    },
  });
  return (
    <Modal
      title={candidate ? 'Edit candidate' : 'Add candidate'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={m.isPending}>
            Cancel
          </button>
          <button type="submit" form="candidate-form" className="btn btn-primary" disabled={!name.trim() || !emailValid || m.isPending}>
            {m.isPending ? 'Saving…' : candidate ? 'Save' : 'Add candidate'}
          </button>
        </>
      }
    >
      <form
        id="candidate-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && emailValid) m.mutate();
        }}
      >
        <label>
          Full name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={300} required />
        </label>
        <label>
          Email (optional)
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!emailValid} />
          {!emailValid ? <span className="text-danger small">Enter a valid email address</span> : null}
        </label>
        <label>
          External ID (optional, e.g. student number)
          <input type="text" value={externalId} onChange={(e) => setExternalId(e.target.value)} maxLength={200} />
        </label>
        {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      </form>
    </Modal>
  );
}
