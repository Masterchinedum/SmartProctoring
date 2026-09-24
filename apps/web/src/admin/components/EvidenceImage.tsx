import { useState } from 'react';
import type { EvidenceRefDTO } from '@sp/shared';
import { formatDate, formatDateTime, formatTime } from '../lib/format';

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

const ALT_KIND: Record<EvidenceRefDTO['kind'], string> = {
  event_screenshot: 'Webcam screenshot',
  identity_probe: 'Webcam identity sample',
  identity_reference: 'Identity reference image',
  id_photo: 'ID photo',
  liveness_frame: 'Live-person check frame',
};

/**
 * Text alternative for an evidence image: what it is, when it was captured and what it belongs to,
 * e.g. "Webcam screenshot at 10:32:05 — More than one person in view".
 */
export function evidenceAlt(ev: Pick<EvidenceRefDTO, 'kind' | 'capturedAt'>, context?: string | null): string {
  const base = `${ALT_KIND[ev.kind] ?? evidenceKindLabel(ev.kind)} at ${formatTime(ev.capturedAt)}`;
  return context ? `${base} — ${context}` : base;
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
  context,
  onOpen,
  caption,
  eager = false,
}: {
  evidence: EvidenceRefDTO | null | undefined;
  size?: Size;
  /** Explicit text alternative ('' = decorative, e.g. a thumbnail inside a labelled button). */
  alt?: string;
  /** What the image belongs to (event title, check), appended to the default alt text. */
  context?: string | null;
  onOpen?: () => void;
  caption?: boolean;
  /** Load immediately (e.g. printable report, where lazy images would be missing from the printout). */
  eager?: boolean;
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
  const altText = alt ?? evidenceAlt(evidence, context);
  const img = (
    <img
      src={evidence.url}
      alt={altText}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
  return (
    <figure className={cls}>
      {onOpen ? (
        <button type="button" className="evidence-btn" onClick={onOpen} title="Open image" aria-label={altText ? `${altText} (open larger)` : 'Open image'}>
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
