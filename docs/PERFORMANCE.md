# Performance and capacity

How many candidates one SmartProctoring server instance carries, what limited it, what was changed, and how to
size a deployment. All numbers come from `e2e/scripts/load-test.ts` against a real server (real Postgres, real
YuNet/SFace inference on real face photos); the method is in §2 so every number can be reproduced.

## 1. Summary

__SUMMARY__

## 2. Method

**Load.** `e2e/scripts/load-test.ts` simulates N candidates through the real candidate API: privacy consent,
initial check-in with 3 real JPEG frames (640×480, server-side face detection + embedding + reference
building), exam start, then per candidate a heartbeat every 5 s, an identity sample (real JPEG) every 30 s, an
event batch every 20 s and an answer save every 25 s. Check-ins are spread evenly over `RAMP_SEC`
(e.g. N=500 in 60 s = 8.3 check-ins/s = 25 face analyses/s on top of the running samples); then
`DURATION_SEC` of steady exam traffic. It reports p50/p95/p99 per endpoint for the whole run and for the steady
phase (from ramp end + 15 s), requests/s, identity samples/s and why check-ins failed. `STAFF_WS=<n>` keeps n
staff dashboards connected to `/api/admin/live` (realtime messages are only built while someone listens).
About 18 % of the test photos never pass the check-in quality gate ("We could not verify your identity from
these images") — that is a property of the photo set, identical before and after, not a load effect.

**Box.** 4 vCPU / 16 GB VM, Node 22, Postgres 16 on the same VM (TCP 127.0.0.1), the load generator on the
same VM too (≈0.1–0.2 vCPU). The VM is shared with other work (e2e browser runs, test suites); runs marked
*quiet* started with a 1-min load average < 2.5 and no browser tests running. Noisy runs are several times
slower at the tail — compare only runs taken under similar conditions.

**Instrumentation** (not part of the product; a `--import` preload during the investigation):
`perf_hooks.monitorEventLoopDelay` + event-loop utilisation, Postgres pool size / waiting clients / acquire
wait (patched `pg.Pool#connect`), query counts, and V8 CPU profiles of the main thread taken over 60 s windows
through `node:inspector` (aggregated by self time per function / file). Postgres table statistics
(`pg_stat_user_tables`) for HOT updates and index use.

```bash
psql -h 127.0.0.1 -U postgres -c 'create database proctor_perf'
pnpm --filter @sp/server build
cd apps/server && DATABASE_URL=postgres://postgres@127.0.0.1:5432/proctor_perf PORT=8097 \
  PUBLIC_URL=http://127.0.0.1:8097 STORAGE_DIR=/tmp/perf-storage LOG_LEVEL=warn \
  BOOTSTRAP_ADMIN_EMAIL=perf@example.com BOOTSTRAP_ADMIN_PASSWORD=PerfTest12345 node dist/main.js
cd e2e && BASE=http://127.0.0.1:8097 STAFF_EMAIL=perf@example.com STAFF_PASSWORD=PerfTest12345 \
  N=500 RAMP_SEC=60 DURATION_SEC=120 STAFF_WS=1 FACES_DIR=/path/to/face/jpegs npx tsx scripts/load-test.ts
# max identity-sample throughput: N=150 RAMP_SEC=30 DURATION_SEC=90 SAMPLE_SEC=1
```

## 3. Bottlenecks found

### 3.1 Face inference ran on the event loop (the collapse)
`onnxruntime-node`'s `InferenceSession.run()` is **synchronous**: it blocks the calling JS thread for the whole
inference (the intra-op thread pool only splits the work; the old code comment assumed otherwise). CPU profile
of the main thread, 60 s at N=500, before:

| self time (main thread) | share |
|---|---|
| onnxruntime `run()` (native, called from `setImmediate`) | **46.7 %** |
| socket writes to Postgres (`writev`) | 9.1 % |
| garbage collection | 6.4 % |
| drizzle query building + pg result parsing | ≈ 17 % |
| JS pixel loops (letterbox packing 1.9 %, image stats/dHash 0.8 %, alignment warp 0.5 %) | 3.2 % |
| idle | 1.7 % |

Event-loop utilisation was 1.0 for the whole run. Every blocked inference stalled all in-flight transactions,
so all 20 Postgres connections sat idle-in-transaction while 1,700–2,700 requests queued for a connection
(average acquire wait ≈ 3 s) — that is why a trivial heartbeat took seconds. At N=200 inference was already
24 % of the main thread. The JS pixel loops (hypothesis a) were real but small (≈3 %); the inference call was
the problem.

### 3.2 Realtime summaries on every mutation (hypothesis b — confirmed)
Every `withSession()` (every heartbeat, answer, event batch, sample) ended with `live.sessionChanged()`, which
re-read the session summary with 5 queries (org lookup, summary join, event counts, pending pause requests,
org lookup again) — also when no staff dashboard was connected, and ≤ 1/s/session did not help because each
session only heartbeats every 5 s. Events and identity checks added 3–4 more queries each. With one dashboard
open at N=200 the old server sent 10,152 session summaries in a run where the new one sends 2,867.

### 3.3 Too many queries per request (hypotheses c, e)
Query build/parse and the socket write per query dominated the rest of the main thread (drizzle's builder
alone ≈ 15 %). Per request (no dashboard open):

| request | before | after | what changed |
|---|---|---|---|
| heartbeat | 11 | **2** | guarded single-statement update; no summary |
| answer save | 11 | 6 | no summary |
| event batch (1 event) | 21 | 8 | no summary/event DTO when unobserved; webhook check folded into the row lock, outbox savepoint skipped without webhooks/mailer |
| identity sample | ≈ 22 | 12 | exam/org rows reused from auth; no re-read of the session; no summary when unobserved |
| check frame | 10 | 8 | no pre-insert lookup for server-generated evidence ids |

Planning the candidate-auth join (4 tables, every candidate request) cost 0.25–0.35 ms of Postgres CPU per
request versus 0.05 ms to execute — it is now a named prepared statement. The pool size itself was not the
problem (20 connections were plenty once the event loop was free; 0 waiters in all runs after the fix).

### 3.4 Heartbeats rewrote every index of exam_sessions
`last_heartbeat_at` was indexed (sweeper look-up), so every heartbeat was a non-HOT update inserting new
entries into all 6 indexes: 18 % HOT updates before, **89 %** after replacing that index by partial indexes on
columns the heartbeat never writes and setting `fillfactor = 80` (migration `0004_hot_heartbeat_indexes`).
The sweeper's clock-expiry query also had no usable index (sequential scan every 5 s over all sessions ever
created); it now has one.

### 3.5 The SFace model file disabled constant folding
The OpenCV-Zoo SFace ONNX lists its 174 weights as graph *inputs* too, so onnxruntime could not fold them
(warning "Initializer … appears in graph inputs"). The models are now loaded through a small protobuf rewrite
that removes those inputs (`vision/onnx-model.ts`): SFace 37 → 29 ms per face on one thread, embeddings
identical (cosine 1.0000000 on 40 faces, max similarity difference 3·10⁻⁷). Per-frame CPU after the change
(one thread): decode 4.5 ms, stats 0.9, letterbox 2.3, YuNet 10.9, SFace 29, alignment 0.5, face crop 2.8.

### 3.6 Not bottlenecks
Synchronous crypto (hypothesis d): AES-GCM of a ≈50 KB JPEG and sha256 are microseconds; scrypt runs only on
staff sign-in and is asynchronous and concurrency-limited. JSON work: < 1 %. Missing indexes on request paths:
none (plans checked; only the sweeper queries of §3.4). Webhook/e-mail hook (e): 3–4 extra queries per event
mutation — removed for organisations without webhooks and without SMTP, unchanged otherwise.

## 4. Changes

* **Vision worker pool** — `apps/server/src/vision/{engine,pool,worker,worker-protocol,service}.ts`: the analysis
  pipeline (decode, detection, alignment, quality, embedding, crop) runs in worker threads, each with its own
  onnxruntime sessions; the `VisionService` interface is unchanged. Bundled as `dist/vision-worker.js`
  (separate tsup entry); from source (tsx dev server, vitest) the `.ts` worker is bootstrapped through tsx.
  Two queues: check-in frames (`interactive`, a candidate waits) before identity samples (`background`,
  `AnalyzeOptions.priority`), with overdue background work alternating so neither starves; `maxQueue` per
  queue → 503 `vision_busy` + `Retry-After`. A crashed worker fails only its own analysis and is replaced.
* **ONNX initializer fix** — `vision/onnx-model.ts` (§3.5).
* **Lazy, coalesced realtime** — `realtime/notifier.ts`, `realtime/bus.ts` (`hasSubscribers`: local listeners, or
  with Redis `PUBSUB NUMSUB` cached 5 s plus an immediate "first subscriber" notice between instances),
  `services/dto.ts` `staffVisibleKey`, `services/session-state.ts`: nothing is loaded for organisations nobody
  watches; summaries are coalesced per session (≤ 1 per 2 s, trailing edge) and batched (one query set per
  50 ms per organisation); a mutation that changes nothing staff see (routine heartbeat) only refreshes the
  summary as a 30 s keepalive; events and identity checks are batched too.
* **Single-statement heartbeat** — `services/candidate-actions.ts` `fastHeartbeat`: one
  `UPDATE … WHERE id = $1 AND xmin = <row version read by candidate auth> RETURNING exists(pending commands)`.
  Anything more (commands to deliver, outage to close, clock start or expiry, a concurrent-use signal, a
  concurrent change of the row) falls back to the unchanged locked path.
* **Fewer queries** — exam/org/candidate rows from candidate auth reused by `withSession` (`SessionPreload`);
  prepared candidate-auth statement (`auth/candidate.ts`); webhook existence checked in the row-lock query;
  no lookup before inserting evidence under a fresh UUID.
* **Postgres** — `PG_POOL_MAX` (default 20), `PG_STATEMENT_TIMEOUT_MS` (default 60 s; migrations lift it),
  migration `0004_hot_heartbeat_indexes` (§3.4).
* **Overload signal** — `lib/load-monitor.ts` logs `server overloaded (event loop lagging | database pool
  exhausted | face analysis queue long)` with the numbers, at most once a minute.
* **Load test** — steady-phase table, requests/s, identity samples/s, check-in failure reasons, `STAFF_WS`.

Tests: `src/vision/pool.test.ts` (priorities, busy, crash/respawn, close, worker resolution),
`src/vision/onnx-model.test.ts`, `src/vision/threading.test.ts`, `src/lib/load-monitor.test.ts`,
`test/perf-paths.test.ts` (fast heartbeat equivalence and fallbacks, xmin guard, visible-change key, notifier
coalescing/keepalive/batching/no-subscriber), `test/realtime-bus.test.ts` (incl. two Redis instances),
`test/infra.test.ts` (config, statement timeout). The real-model vision tests run through the worker pool.

## 5. Results

__RESULTS__

## 6. Sizing guidance

__SIZING__
