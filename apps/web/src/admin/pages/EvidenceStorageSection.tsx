import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EvidenceStorageDTO } from '@sp/shared';
import { useAuth } from '../auth';
import { api, errorMessage, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { changeNote, elsewhereNote, locationLabel, locationText, storedSummary } from '../lib/residency';
import { ErrorState, Loading } from '../components/Common';

/**
 * Settings → where evidence images are stored (data residency). The server operator configures the locations; an
 * owner chooses the one for new images. Only images live there: the database stays where it is — said plainly.
 */
export function EvidenceStorageSection() {
  const q = useQuery({ queryKey: qk.evidenceStorage, queryFn: api.evidenceStorage, retry: shouldRetry });
  // Saving re-keys (remounts) the form: the confirmation lives here.
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <section className="card stack" aria-labelledby="storage-title" data-testid="settings-evidence-storage">
      <h2 id="storage-title">Where evidence images are stored</h2>
      <p className="small muted">
        Evidence images — check-in and identity photos, screenshots taken when something was observed, and approved ID photos — are stored, encrypted, in the location chosen
        here.
      </p>
      <p className="small muted">
        <strong>Not stored there:</strong> everything else stays where this server’s database is — candidate names and email addresses, exams and answers, event records, face
        templates (the numbers used to compare faces) and the audit log.
      </p>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <StorageForm key={q.data.current} dto={q.data} saved={saved} setSaved={setSaved} />}
    </section>
  );
}

function StorageForm({ dto, saved, setSaved }: { dto: EvidenceStorageDTO; saved: string | null; setSaved: (v: string | null) => void }) {
  const { isOwner } = useAuth();
  const qc = useQueryClient();
  const [value, setValue] = useState(dto.current);
  const m = useMutation({
    mutationFn: () => api.updateSettings({ evidenceLocation: value }),
    onSuccess: (s) => {
      qc.setQueryData(qk.settings, s);
      setSaved(s.evidenceLocation);
      void qc.invalidateQueries({ queryKey: qk.evidenceStorage });
    },
  });
  const elsewhere = elsewhereNote(dto);
  if (dto.locations.length <= 1) {
    return (
      <>
        <p className="small" data-testid="storage-single">
          This server has one storage location: <strong>{locationText(dto.locations[0])}</strong>. Your server operator can add others, for example in another region.
        </p>
        <p className="small" data-testid="storage-stored">
          {storedSummary(dto)}
        </p>
      </>
    );
  }
  return (
    <>
      <label>
        Location for new images
        <select
          value={value}
          disabled={!isOwner || m.isPending}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(null);
          }}
          aria-describedby="storage-hint"
          data-testid="storage-location"
        >
          {dto.locations.map((l) => (
            <option key={l.name} value={l.name}>
              {locationText(l)}
            </option>
          ))}
        </select>
        <span id="storage-hint" className="small muted">
          {isOwner ? 'Changes are recorded in the audit log.' : 'Only an owner can change this.'}
        </span>
      </label>
      {value !== dto.current ? (
        <p className="small" data-testid="storage-change-note">
          {changeNote(dto, value)}
        </p>
      ) : null}
      <p className="small" data-testid="storage-stored">
        {storedSummary(dto)}
      </p>
      {elsewhere ? (
        <div className="banner banner-info small" data-testid="storage-elsewhere">
          {elsewhere}
        </div>
      ) : null}
      {m.isError ? (
        <div className="banner banner-danger" role="alert">
          {errorMessage(m.error)}
        </div>
      ) : null}
      {saved && saved === dto.current ? (
        <div className="banner banner-success small" role="status" data-testid="storage-saved">
          Saved. New evidence images are stored in {locationLabel(dto, dto.current)}.
        </div>
      ) : null}
      {isOwner ? (
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={value === dto.current || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? 'Saving…' : 'Save location'}
          </button>
        </div>
      ) : null}
    </>
  );
}
