/**
 * Public multi-image identity sets used for INTERNAL accuracy evaluation of the identity pipeline
 * (webcam simulator, docs/accuracy/identity-v2.md). Images are downloaded on demand into a local cache and
 * are never committed or shipped.
 *
 *   cache dir: $SP_FACESETS_DIR, else /tmp/claude-0/facesets when it exists, else <os tmp>/sp-facesets
 *   layout:    <dir>/<source>/<file>   (+ <dir>/manifest.json written by the fetch script)
 *
 * Every entry is pinned to a commit and fetched from raw.githubusercontent.com (the GitHub API is not needed).
 * Licence notes: the repositories' CODE licences are given per source. The photos themselves are sample /
 * test images shipped with those repositories (stock photos, or photos of public figures taken from the web);
 * their copyright belongs to the respective owners. They are used here only to measure accuracy, locally.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type FacesetSourceId = 'azure' | 'faceapi' | 'deepface' | 'face_recognition' | 'openface' | 'facenet_pytorch';

export interface FacesetSource {
  id: FacesetSourceId;
  repo: string;
  commit: string;
  license: string;
  note: string;
}

export const FACESET_SOURCES: Readonly<Record<FacesetSourceId, FacesetSource>> = Object.freeze({
  azure: {
    id: 'azure',
    repo: 'Azure-Samples/cognitive-services-sample-data-files',
    commit: '65af3b93cab5f45c76594f3265210646d4b3809e',
    license: 'MIT (repository)',
    note: 'Microsoft Face API sample stock photos. Includes FAMILY MEMBERS (hard look-alike impostors): Family1 Dad/Mom/Daughter/Son, Family2 Lady/Man, Family3 Lady/Man.',
  },
  faceapi: {
    id: 'faceapi',
    repo: 'justadudewhohacks/face-api.js',
    commit: 'a86f011d72124e5fb93e59d5c4ab98f699dd5c9c',
    license: 'MIT (code); example images are TV stills, copyright of their owners',
    note: '8 actors x 5 images (face-recognition example).',
  },
  deepface: {
    id: 'deepface',
    repo: 'serengil/deepface',
    commit: 'fc8ff20222c173e38ff6bc0a7c20b10c5ceaf1ad',
    license: 'MIT (code); unit-test photos of public figures, copyright of their owners',
    note: 'tests/unit/dataset; identities from master.csv + face-recognition-pivot.csv same-person pairs (union-find).',
  },
  face_recognition: {
    id: 'face_recognition',
    repo: 'ageitgey/face_recognition',
    commit: '9f3061aaeed9a8756d2c970f5dfe066617a8281d',
    license: 'MIT (code); example photos of public figures',
    note: 'examples/ and examples/knn_examples/{train,test}. obama-240p/480p/720p/1080p are the same photo and are not used.',
  },
  openface: {
    id: 'openface',
    repo: 'cmusatyalab/openface',
    commit: '99b7241a8748421e2c5e32ccf7581c08e513e79e',
    license: 'Apache-2.0 (code); example photos of public figures',
    note: 'images/examples.',
  },
  facenet_pytorch: {
    id: 'facenet_pytorch',
    repo: 'timesler/facenet-pytorch',
    commit: '787da06156087cd6b616fe6608213722bddc30cd',
    license: 'MIT (code); test photos of public figures',
    note: 'data/test_images (one photo per person: impostors only).',
  },
});

export interface FacesetEntry {
  source: FacesetSourceId;
  /** Path inside the source repository. */
  path: string;
  /** Globally unique identity label, "<source>:<name>". */
  identity: string;
  /** Family group (blood relatives / spouses) — impostor pairs inside a family are reported separately. */
  family?: string;
}

const e = (source: FacesetSourceId, path: string, name: string, family?: string): FacesetEntry => ({ source, path, identity: `${source}:${name}`, ...(family ? { family } : {}) });

const AZ = 'Face/images/';
const FA = 'examples/images/';
const DF = 'tests/unit/dataset/';
const FR = 'examples/';

/** deepface identities (union-find over the same-person pairs of master.csv and face-recognition-pivot.csv). */
const DEEPFACE_GROUPS: readonly (readonly number[])[] = [
  [1, 2, 4, 5, 6, 7, 10, 11],
  [26, 27, 28, 42, 43, 44, 45, 46],
  [8, 9, 47, 48, 49, 50, 51],
  [3, 12, 53, 54, 55, 56],
  [13, 14, 15, 57, 58],
  [29, 30, 31, 32, 33],
  [16, 17, 59, 61, 62],
  [38, 39, 40, 41],
  [34, 35, 36, 37],
  [18, 19, 67],
  [20, 21],
  [22, 23],
  [24, 25],
];

export const FACESET_MANIFEST: readonly FacesetEntry[] = Object.freeze([
  // Azure sample data (stock photos; families).
  ...[1, 2, 3].map((i) => e('azure', `${AZ}Family1-Dad${i}.jpg`, 'family1-dad', 'azure-family1')),
  ...[1, 2].map((i) => e('azure', `${AZ}Family1-Mom${i}.jpg`, 'family1-mom', 'azure-family1')),
  ...[1, 2, 3].map((i) => e('azure', `${AZ}Family1-Daughter${i}.jpg`, 'family1-daughter', 'azure-family1')),
  ...[1, 2].map((i) => e('azure', `${AZ}Family1-Son${i}.jpg`, 'family1-son', 'azure-family1')),
  ...[1, 2].map((i) => e('azure', `${AZ}Family2-Lady${i}.jpg`, 'family2-lady', 'azure-family2')),
  ...[1, 2].map((i) => e('azure', `${AZ}Family2-Man${i}.jpg`, 'family2-man', 'azure-family2')),
  e('azure', `${AZ}Family3-Lady1.jpg`, 'family3-lady', 'azure-family3'),
  e('azure', `${AZ}Family3-Man1.jpg`, 'family3-man', 'azure-family3'),
  // (The person-group sample images man/woman/child{1..3} are byte-identical copies of Family2-Man, Family2-Lady
  // and Family1-Daughter, so they are not listed.)
  // face-api.js example (8 x 5).
  ...['amy', 'bernadette', 'howard', 'leonard', 'penny', 'raj', 'sheldon', 'stuart'].flatMap((n) => [1, 2, 3, 4, 5].map((i) => e('faceapi', `${FA}${n}/${n}${i}.png`, n))),
  // deepface unit-test set.
  ...DEEPFACE_GROUPS.flatMap((g, k) => g.map((i) => e('deepface', `${DF}img${i}.jpg`, `p${String(k + 1).padStart(2, '0')}`))),
  // face_recognition examples.
  e('face_recognition', `${FR}knn_examples/train/alex_lacamoire/img1.jpg`, 'alex_lacamoire'),
  e('face_recognition', `${FR}knn_examples/test/alex_lacamoire1.jpg`, 'alex_lacamoire'),
  e('face_recognition', `${FR}alex-lacamoire.png`, 'alex_lacamoire'),
  e('face_recognition', `${FR}knn_examples/train/biden/biden.jpg`, 'biden'),
  e('face_recognition', `${FR}knn_examples/train/biden/biden2.jpg`, 'biden'),
  e('face_recognition', `${FR}knn_examples/train/kit_harington/john1.jpeg`, 'kit_harington'),
  e('face_recognition', `${FR}knn_examples/train/kit_harington/john2.jpeg`, 'kit_harington'),
  e('face_recognition', `${FR}knn_examples/test/johnsnow_test1.jpg`, 'kit_harington'),
  e('face_recognition', `${FR}knn_examples/train/obama/obama.jpg`, 'obama'),
  e('face_recognition', `${FR}knn_examples/train/obama/obama2.jpg`, 'obama'),
  e('face_recognition', `${FR}knn_examples/test/obama1.jpg`, 'obama'),
  e('face_recognition', `${FR}knn_examples/train/rose_leslie/img1.jpg`, 'rose_leslie'),
  e('face_recognition', `${FR}knn_examples/train/rose_leslie/img2.jpg`, 'rose_leslie'),
  e('face_recognition', `${FR}lin-manuel-miranda.png`, 'lin_manuel_miranda'),
  // openface examples.
  e('openface', 'images/examples/clapton-1.jpg', 'clapton'),
  e('openface', 'images/examples/clapton-2.jpg', 'clapton'),
  e('openface', 'images/examples/lennon-1.jpg', 'lennon'),
  e('openface', 'images/examples/lennon-2.jpg', 'lennon'),
  e('openface', 'images/examples/adams.jpg', 'adams'),
  e('openface', 'images/examples/carell.jpg', 'carell'),
  // facenet-pytorch test images (single photos).
  ...['angelina_jolie', 'bradley_cooper', 'kate_siegel', 'paul_rudd', 'shea_whigham'].map((n) => e('facenet_pytorch', `data/test_images/${n}/1.jpg`, n)),
]);

/**
 * Cross-source identity aliases: the same real person appearing in two sources (found by reviewing
 * high-similarity cross-identity pairs, see the fetch script's --audit). Maps identity -> canonical identity.
 */
export const IDENTITY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Same actress (clean similarity 0.65-0.79 to all 8 deepface p01 photos; visually confirmed).
  'facenet_pytorch:angelina_jolie': 'deepface:p01',
});

export function canonicalIdentity(id: string): string {
  return IDENTITY_ALIASES[id] ?? id;
}

export function rawUrl(entry: Pick<FacesetEntry, 'source' | 'path'>): string {
  const s = FACESET_SOURCES[entry.source];
  return `https://raw.githubusercontent.com/${s.repo}/${s.commit}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Local cache file of an entry. */
export function localPath(dir: string, entry: Pick<FacesetEntry, 'source' | 'path'>): string {
  return join(dir, entry.source, entry.path.replace(/[\\/]/g, '__'));
}

export function defaultFacesetsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SP_FACESETS_DIR) return env.SP_FACESETS_DIR;
  if (existsSync('/tmp/claude-0/facesets')) return '/tmp/claude-0/facesets';
  return join(tmpdir(), 'sp-facesets');
}

export interface LocalFacesetImage extends FacesetEntry {
  file: string;
}

export interface LocalFaceset {
  dir: string;
  images: LocalFacesetImage[];
  /** Canonical identities with their images. */
  identities: Map<string, LocalFacesetImage[]>;
  missing: FacesetEntry[];
}

/** The manifest entries present in the cache, grouped by canonical identity. */
export function loadFaceset(dir: string = defaultFacesetsDir(), manifest: readonly FacesetEntry[] = FACESET_MANIFEST): LocalFaceset {
  const images: LocalFacesetImage[] = [];
  const missing: FacesetEntry[] = [];
  for (const m of manifest) {
    const file = localPath(dir, m);
    if (existsSync(file)) images.push({ ...m, identity: canonicalIdentity(m.identity), file });
    else missing.push(m);
  }
  const identities = new Map<string, LocalFacesetImage[]>();
  for (const img of images) identities.set(img.identity, [...(identities.get(img.identity) ?? []), img]);
  return { dir, images, identities, missing };
}

export interface FetchResult {
  entry: FacesetEntry;
  status: 'cached' | 'downloaded' | 'missing' | 'error';
  bytes?: number;
  error?: string;
}

/** Download every manifest entry not yet cached (HEAD probe, then GET). */
export async function fetchFaceset(
  dir: string = defaultFacesetsDir(),
  opts: { manifest?: readonly FacesetEntry[]; concurrency?: number; onProgress?: (r: FetchResult) => void } = {},
): Promise<FetchResult[]> {
  const { mkdirSync, writeFileSync, statSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const manifest = opts.manifest ?? FACESET_MANIFEST;
  const results: FetchResult[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= manifest.length) return;
      const entry = manifest[i];
      const file = localPath(dir, entry);
      let r: FetchResult;
      if (existsSync(file) && statSync(file).size > 0) {
        r = { entry, status: 'cached', bytes: statSync(file).size };
      } else {
        try {
          const url = rawUrl(entry);
          const head = await fetch(url, { method: 'HEAD' });
          if (head.status === 404) {
            r = { entry, status: 'missing' };
          } else {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = Buffer.from(await res.arrayBuffer());
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, buf);
            r = { entry, status: 'downloaded', bytes: buf.length };
          }
        } catch (err) {
          r = { entry, status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
      }
      results.push(r);
      opts.onProgress?.(r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 6) }, worker));
  return results;
}
