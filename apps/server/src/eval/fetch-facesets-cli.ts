/**
 * Download the public identity sets used by the webcam evaluation into a local cache (never committed).
 *
 *   pnpm --filter @sp/server eval:fetch-faces [-- --dir <cache dir>] [--audit]
 *
 * --dir     cache directory (default: $SP_FACESETS_DIR, else /tmp/claude-0/facesets if present, else <tmp>/sp-facesets)
 * --audit   analyse every image (face count, detector score, inter-eye px) and list suspicious label pairs:
 *           different identities with clean similarity >= 0.5 (possible same person across sources) and
 *           same-identity images with similarity >= 0.97 (near-duplicate photos).
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FACESET_MANIFEST, FACESET_SOURCES, defaultFacesetsDir, fetchFaceset, loadFaceset, rawUrl } from './datasets';

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
  const { values } = parseArgs({ args, options: { dir: { type: 'string' }, audit: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log('Usage: eval:fetch-faces [--dir <cache>] [--audit]');
    return 0;
  }
  const dir = values.dir ?? defaultFacesetsDir();
  mkdirSync(dir, { recursive: true });
  const results = await fetchFaceset(dir, {
    onProgress: (r) => {
      if (r.status !== 'cached') process.stderr.write(`[fetch] ${r.status.padEnd(10)} ${r.entry.source}/${r.entry.path}${r.error ? ` (${r.error})` : ''}\n`);
    },
  });
  const count = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`cache: ${dir}\n  cached ${count('cached')}, downloaded ${count('downloaded')}, missing ${count('missing')}, errors ${count('error')}`);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        note: 'Internal evaluation only. Do not commit or redistribute these images.',
        sources: FACESET_SOURCES,
        entries: FACESET_MANIFEST.map((m) => ({ ...m, url: rawUrl(m), status: results.find((r) => r.entry === m)?.status })),
      },
      null,
      2,
    ),
  );
  const ds = loadFaceset(dir);
  const multi = [...ds.identities.values()].filter((v) => v.length >= 2).length;
  console.log(`  ${ds.images.length} images, ${ds.identities.size} identities (${multi} with >= 2 images)`);
  if (values.audit) await audit(dir);
  return count('error') > 0 ? 1 : 0;
}

async function audit(dir: string): Promise<void> {
  const { createVisionService } = await import('../vision/service');
  const { cosineSimilarity } = await import('../vision/identity');
  const vision = await createVisionService({});
  try {
    const ds = loadFaceset(dir);
    const emb = new Map<string, Float32Array>();
    for (const img of ds.images) {
      const a = await vision.analyze(readFileSync(img.file), { embed: true });
      const q = a.quality;
      const flag = a.faces.length !== 1 ? `  <-- ${a.faces.length} faces` : '';
      console.log(`${img.identity.padEnd(30)} ${img.path.split('/').pop()!.padEnd(28)} faces ${a.faces.length} score ${q.detectionScore.toFixed(2)} ie ${q.interEyePx.toFixed(0).padStart(4)} yaw ${q.yawDeg.toFixed(0).padStart(4)}${flag}`);
      if (a.embedding) emb.set(img.file, a.embedding);
    }
    const list = ds.images.filter((i) => emb.has(i.file));
    console.log('\nSuspicious pairs:');
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = cosineSimilarity(emb.get(list[i].file)!, emb.get(list[j].file)!);
        const same = list[i].identity === list[j].identity;
        if ((!same && s >= 0.5) || (same && s >= 0.97)) console.log(`  ${same ? 'DUPLICATE?' : 'SAME PERSON?'} ${s.toFixed(3)} ${list[i].identity}/${list[i].path.split('/').pop()} ~ ${list[j].identity}/${list[j].path.split('/').pop()}`);
      }
    }
  } finally {
    await vision.close();
  }
}

main().then(
  (c) => process.exit(c),
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  },
);
