import { useState } from 'react';
import type { EvidenceRefDTO } from '@sp/shared';
import { formatDate, formatDateTime } from '../lib/format';

const KIND_LABELS: Record<EvidenceRefDTO['kind'], string> = {
  event_screenshot: 'Screenshot',
  identity_probe: 'Identity sample',
  identity_reference: 'Identity reference',
  id_photo: 'ID photo',
  liveness_frame: 'Liveness frame',
};

export function evidenceKindLabel(kind: EvidenceRefDTO['kind']): string {
  return KIND_LABELS[kind] ?? kind;
}

type Size = 'thumb' | 'small' | 'medium' | 'large';

/**
 * Protected evidence image (lazy-loaded; each view is audit-logged by the server). Shows a tombstone
 * when the image was deleted under the retention policy, and a fallback when it can't be loaded.
 */
export function EvidenceImage({
  evidence,
  size = 'medium',
  alt,
  onOpen,
  caption,
}: {
  evidence: EvidenceRefDTO | null | undefined;
  size?: Size;
  alt?: string;
  onOpen?: () => void;
  caption?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const cls = `evidence evidence-${size}`;
  if (!evidence) {
    return (
      <div className={`${cls} evidence-missing`}>
        <span>No image</span>
      </div>
    );
  }
  if (!evidence.available) {
    return (
      <div className={`${cls} evidence-purged`} title={evidence.purgedAt ? `Deleted ${formatDateTime(evidence.purgedAt)}` : 'Deleted'}>
        <span>{evidence.purgedAt ? `Deleted under the retention policy on ${formatDate(evidence.purgedAt)}` : 'Deleted under the retention policy'}</span>
      </div>
    );
  }
  if (failed) {
    return (
      <div className={`${cls} evidence-missing`}>
        <span>Image unavailable</span>
      </div>
    );
  }
  const img = (
    <img
      src={evidence.url}
      alt={alt ?? `${evidenceKindLabel(evidence.kind)} captured ${formatDateTime(evidence.capturedAt)}`}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
  return (
    <figure className={cls}>
      {onOpen ? (
        <button type="button" className="evidence-btn" onClick={onOpen} title="Open image">
          {img}
        </button>
      ) : (
        img
      )}
      {caption ? (
        <figcaption>
          {evidenceKindLabel(evidence.kind)} · {formatDateTime(evidence.capturedAt)}
        </figcaption>
      ) : null}
    </figure>
  );
}
