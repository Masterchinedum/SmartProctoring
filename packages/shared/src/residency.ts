/**
 * Data residency: where an organisation's evidence images are stored. The server operator configures the storage
 * locations (STORAGE_LOCATIONS; docs/OPERATIONS.md §2); an organisation's owner chooses among them for new images
 * (Settings, `PUT /api/admin/settings { evidenceLocation }`). Existing images are moved by the operator
 * (`storage:move`). The database — candidate records, exams, answers, event records, face templates, the audit log —
 * stays where the database is: only images live in the chosen location.
 */
import { z } from 'zod';

/** The location configured by STORAGE_DRIVER / STORAGE_DIR / S3_*; organisations use it unless they choose another. */
export const DEFAULT_EVIDENCE_LOCATION = 'default';

/** A storage location name (as configured by the operator). */
export const evidenceLocationSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'Not a storage location name');

/** What staff see of a storage location: never a bucket, directory, endpoint or credential. */
export interface StorageLocationDTO {
  /** `default` or the operator's name for it, e.g. `eu`. */
  name: string;
  /** e.g. "EU (Frankfurt)". */
  label: string;
  /** The bucket's region for object storage (e.g. `eu-central-1`); null for a server directory. */
  region: string | null;
  isDefault: boolean;
}

/** GET /api/admin/evidence-storage [admin] */
export interface EvidenceStorageDTO {
  /** Where this organisation's new evidence images are stored (= OrgSettingsDTO.evidenceLocation). */
  current: string;
  /** The locations configured on this server, `default` first. */
  locations: StorageLocationDTO[];
  /** Images of this organisation not yet deleted, per location (every configured location listed, 0 included). */
  stored: { location: string; images: number }[];
}
