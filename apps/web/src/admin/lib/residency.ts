import type { EvidenceStorageDTO, StorageLocationDTO } from '@sp/shared';
import { pluralize } from './format';

/** "EU (Frankfurt), region eu-central-1": the operator's label, with the bucket's region when it is not already in it. */
export function locationText(l: Pick<StorageLocationDTO, 'label' | 'region'>): string {
  return l.region && !l.label.toLowerCase().includes(l.region.toLowerCase()) ? `${l.label}, region ${l.region}` : l.label;
}

/** The label of a location name (the name itself if the server no longer lists it). */
export function locationLabel(dto: Pick<EvidenceStorageDTO, 'locations'>, name: string): string {
  return dto.locations.find((l) => l.name === name)?.label ?? name;
}

function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Stored now: 120 images in Default storage and 36 in EU (Frankfurt)." */
export function storedSummary(dto: EvidenceStorageDTO): string {
  const parts = dto.stored.filter((s) => s.images > 0);
  if (!parts.length) return 'No evidence images are stored at the moment.';
  return `Stored now: ${joinAnd(parts.map((p, i) => `${i === 0 ? pluralize(p.images, 'image') : p.images} in ${locationLabel(dto, p.location)}`))}.`;
}

/**
 * Images kept outside the organisation's current location (stored before it changed): they stay where they are, and
 * readable, until the server operator moves them (`storage:move`). null when there are none.
 */
export function elsewhereNote(dto: EvidenceStorageDTO): string | null {
  const other = dto.stored.filter((s) => s.location !== dto.current && s.images > 0);
  if (!other.length) return null;
  const n = other.reduce((a, s) => a + s.images, 0);
  return (
    `${pluralize(n, 'earlier image')} ${n === 1 ? 'is' : 'are'} still stored in ${joinAnd(other.map((s) => locationLabel(dto, s.location)))}. ` +
    `${n === 1 ? 'It stays' : 'They stay'} there, and can be viewed as before, until your server operator moves ${n === 1 ? 'it' : 'them'} to ${locationLabel(dto, dto.current)}.`
  );
}

/** What saving a new choice does (shown before saving). */
export function changeNote(dto: Pick<EvidenceStorageDTO, 'locations'>, next: string): string {
  return `From the moment you save, new images are stored in ${locationLabel(dto, next)}. Images already stored stay where they are until your server operator moves them.`;
}
