/**
 * Download the public face photos the e2e camera fixtures are made from (README "Face images and fixtures") — and
 * the server's real-model tests read (SP_TEST_FACES_DIR) — into E2E_FACES_DIR, from pinned commits of their
 * MIT-licensed repositories, and verify every file's SHA-256: the same bytes on every machine and in CI, without
 * copying faces into this repository.
 *
 *   pnpm --filter @sp/e2e fetch-faces        (E2E_FACES_DIR, default /tmp/claude-0/faces)
 *
 * Files already present with the right hash are kept. Exit code 1 when a download fails or a hash differs.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FACES_DIR } from '../lib/config';

const FACE_RECOGNITION = 'https://raw.githubusercontent.com/ageitgey/face_recognition/9f3061aaeed9a8756d2c970f5dfe066617a8281d/examples';
const DEEPFACE = 'https://raw.githubusercontent.com/serengil/deepface/fc8ff20222c173e38ff6bc0a7c20b10c5ceaf1ad/tests/unit/dataset';

const FILES: { name: string; url: string; sha256: string }[] = [
  { name: 'obama.jpg', url: `${FACE_RECOGNITION}/obama.jpg`, sha256: '0930e3aa8cae5920329c0c8cbc6a2ab70f47b0e67b432875beaa95cbf7e741f6' },
  { name: 'obama2.jpg', url: `${FACE_RECOGNITION}/obama2.jpg`, sha256: 'a7efcc907375274796f39646510704aa86672d59f6d5469d69af3c85590976a6' },
  { name: 'two_people.jpg', url: `${FACE_RECOGNITION}/two_people.jpg`, sha256: '536b29cd513fb618e4d5aa79d51a279948daa804ce359463449cce5f9dc68aa7' },
  { name: 'obama_small.jpg', url: `${FACE_RECOGNITION}/obama_small.jpg`, sha256: 'a17d127a14c9bd57ef79ce5e89a7b4003b641ef98c2e17be4e1acbb049d6eb24' },
  { name: 'biden.jpg', url: `${FACE_RECOGNITION}/biden.jpg`, sha256: '3c17508bb91554c637a2eabddfae790e5bb1caba93130814fc2ac50be9760c4c' },
  { name: 'deepface/img30.jpg', url: `${DEEPFACE}/img30.jpg`, sha256: '88399f082f008097494a02b1a15ea31ededf23348f9978e39d800ca38f97c90a' },
  { name: 'deepface/img13.jpg', url: `${DEEPFACE}/img13.jpg`, sha256: '008abcc9464f39cdd8d0f097b54e5d6fc064073b07cc2917f80d787351563190' },
];

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let failed = 0;
for (const f of FILES) {
  const dest = join(FACES_DIR, f.name);
  if (existsSync(dest) && sha256(readFileSync(dest)) === f.sha256) {
    console.log(`cached      ${f.name}`);
    continue;
  }
  try {
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    const got = sha256(body);
    if (got !== f.sha256) throw new Error(`SHA-256 ${got}, expected ${f.sha256}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
    console.log(`downloaded  ${f.name}`);
  } catch (err) {
    failed++;
    console.error(`FAILED      ${f.name}: ${(err as Error).message} (${f.url})`);
  }
}
console.log(`${FACES_DIR}: ${FILES.length - failed}/${FILES.length} face images`);
process.exit(failed ? 1 : 0);
