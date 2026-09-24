import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EvidenceRefDTO } from '@sp/shared';
import { formatDate, formatDateTime } from '../lib/format';
import { evidenceKindLabel } from './EvidenceImage';

export interface LightboxItem {
  evidence: EvidenceRefDTO;
  caption?: string;
}

/** Full-screen image viewer with keyboard navigation (← → Esc). */
export function Lightbox({ items, index, onClose }: { items: LightboxItem[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(Math.min(Math.max(0, index), Math.max(0, items.length - 1)));
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const n = items.length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowRight') setI((x) => (x + 1) % n);
      else if (e.key === 'ArrowLeft') setI((x) => (x - 1 + n) % n);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [n, onClose]);
  if (n === 0) return null;
  const item = items[i];
  const ev = item.evidence;
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Image viewer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <button type="button" className="lightbox-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      {n > 1 ? (
        <button type="button" className="lightbox-nav prev" aria-label="Previous image" onClick={() => setI((x) => (x - 1 + n) % n)}>
          ‹
        </button>
      ) : null}
      <div className="lightbox-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {!ev.available ? (
          <div className="lightbox-missing">
            {ev.purgedAt ? `Deleted under the retention policy on ${formatDate(ev.purgedAt)}` : 'Deleted under the retention policy'}
          </div>
        ) : failed[ev.id] ? (
          <div className="lightbox-missing">Image unavailable</div>
        ) : (
          <img src={ev.url} alt={item.caption ?? evidenceKindLabel(ev.kind)} onError={() => setFailed((f) => ({ ...f, [ev.id]: true }))} />
        )}
      </div>
      {n > 1 ? (
        <button type="button" className="lightbox-nav next" aria-label="Next image" onClick={() => setI((x) => (x + 1) % n)}>
          ›
        </button>
      ) : null}
      <div className="lightbox-caption">
        <strong>{item.caption ?? evidenceKindLabel(ev.kind)}</strong> · captured {formatDateTime(ev.capturedAt)}
        {n > 1 ? (
          <span className="muted">
            {' '}
            · {i + 1} / {n}
          </span>
        ) : null}
        {ev.available ? (
          <a className="lightbox-open" href={ev.url} target="_blank" rel="noreferrer">
            Open original
          </a>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
