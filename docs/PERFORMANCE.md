# Performance and capacity

How many candidates one SmartProctoring server instance carries, what limited it, what was changed, and how to
size a deployment. All numbers come from `e2e/scripts/load-test.ts` against a real server (real Postgres, real
YuNet/SFace inference on real face photos); the method is in §2 so every number can be reproduced.

**Identity v2 (re-measured 2026-09-25, §7) changed the capacity picture.**
- *Why:* each candidate now sends 15× more frames for face analysis in the first 3 minutes after an exam starts or
  resumes (a 3-frame burst every 6 s), and 6× more afterwards (every 15 s). Each frame costs 1.9× the CPU (flip
  test-time augmentation and a mirrored detection).
- *Result:* one 4-vCPU instance now carries **≈ 45 candidates who start together (≈ 11 per vCPU)** and ≈ 110 in
  steady state. §6 is the current sizing.
- *Unchanged:* the request path is not affected. Heartbeat p95 stays ≤ 28 ms even at N=500 with face analysis
  saturated.
- *History:* §1–§5 describe the identity-v1 optimisation work and its measurements.

## 1. Summary (identity v1)

One 4-vCPU instance (Postgres and the load generator on the same VM), load test with a 60 s check-in ramp
and 120 s of exam traffic, no staff dashboard open (quiet runs, §2), whole-run p50 / p95 in ms:

| endpoint | N=200 before | N=200 after | N=500 before | N=500 after |
|---|---|---|---|---|
| heartbeat | 7 / 44 | **3 / 5** | 1,426 / 2,836 | **3 / 8** |
| answer save | 7 / 44 | **5 / 8** | 2,074 / 4,175 | **5 / 12** |
| event batch | 10 / 70 | **6 / 10** | 1,476 / 2,941 | **6 / 14** |
| identity sample | 72 / 167 | **63 / 78** | 3,569 / 7,010 | **66 / 96** |
| check frame | 52 / 120 | **61 / 73** | 5,932 / 13,744 | **68 / 98** |
| check complete | 27 / 73 | **21 / 30** | 9,811 / 18,016 | **25 / 50** |
| errors | 0 | 0 | 0 | 0 |

(An earlier measurement of the old code on a busier VM: N=200 heartbeat 10 / 97, identity sample 85 / 323,
check frame 115 / 331; N=500 heartbeat 3.7 s / 6.6 s, identity sample p50 9.7 s, check frame p50 7.3 s.)
With a staff dashboard connected N=500 is unchanged (heartbeat 3 / 9, identity sample 66 / 104).

* **Root causes**: face inference (onnxruntime-node, synchronous) ran on the event loop — 47 % of the main
  thread at N=500 — so every request queued behind it and the 20 Postgres connections sat idle in
  transactions; plus a realtime session summary (5 queries) after every heartbeat, answer, event and sample even
  with no dashboard open; heartbeats that rewrote every index of `exam_sessions`.
* **Knee** (after): the request path (heartbeats, answers, events) stays under 70 ms p95 up to N=1,200; the
  limit is face analysis: **≈ 52 identity samples/s per instance** (3 vision workers on 4 vCPU). N=1,000 with
  check-ins spread over 2 min meets every target in steady state; N=800 checking in within 1 min (13 check-ins/s)
  queues check frames (p95 6 s); N=1,200 saturates vision (identity samples wait seconds, some 503s).
* **Sizing** (identity v1): ≈ 250 concurrent candidates per vCPU at a 30 s identity interval and ≈ 2 check-ins/s
  per vCPU of start-up burst. **Superseded for identity v2**: ≈ 11 per vCPU when candidates start together, see
  §6 and §7.

## 2. Method

**Load.** `e2e/scripts/load-test.ts` simulates N candidates through the real candidate API. The identity-v1
measurements in §1–§5 used the v1 client behaviour, which is now `CADENCE=v1`; the default is the identity-v2
cadence (§7.1). The v1 behaviour: privacy consent, initial check-in with 3 real JPEG frames (640×480, server-side face detection + embedding + reference
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
  CADENCE=v1 N=500 RAMP_SEC=60 DURATION_SEC=120 STAFF_WS=1 FACES_DIR=/path/to/face/jpegs npx tsx scripts/load-test.ts
# max identity-sample throughput: CADENCE=v1 N=150 RAMP_SEC=30 DURATION_SEC=90 SAMPLE_SEC=1
# identity v2 (default cadence): N=150 RAMP_SEC=60 DURATION_SEC=360 (§7.1)
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
  summary as a 10 s keepalive (only while someone watches); events and identity checks are batched too.
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

All runs: 4 vCPU VM, Postgres + load generator on the same VM, bundled server (`node dist/main.js`), default
settings (3 vision workers × 1 thread, `PG_POOL_MAX=20`), quiet VM unless noted. p50 / p95 in ms.

### 5.1 Before / after
See §1 (N=200 and N=500, no dashboard). Before = commit `e9d595c` (the state this work started from), after =
this change set; same VM, same parameters, runs minutes apart.

### 5.2 Knee (after, one staff dashboard connected)

| N | ramp | check-ins/s | heartbeat | answer | events | identity sample (whole run) | identity sample (steady) | check frame | errors |
|---|---|---|---|---|---|---|---|---|---|
| 500 | 60 s | 8.3 | 3 / 9 | 5 / 13 | 6 / 15 | 66 / 104 | 65 / 84 | 71 / 112 | 0 |
| 800 | 60 s | 13.3 | 5 / 20 | 7 / 32 | 9 / 38 | 84 / 5,204 | 74 / 2,509 | 964 / 5,998 | 0 |
| 1,000 | 120 s | 8.3 | 6 / 19 | 9 / 31 | 11 / 37 | 91 / 5,357 | 78 / 146 | 95 / 300 | 0 |
| 1,200 | 150 s | 8.0 | 9 / 30 | 14 / 54 | 17 / 65 | 204 / 11,799 | 136 / 6,266 | 98 / 2,404 | 120 × 503¹ |

¹ identity samples still refused after 3 retries (882 were retried successfully) — the vision queue was full.

Reading the table: the request path scales past 1,200 candidates (196 heartbeats/s at p95 22 ms in the
steady phase of N=1,200); face analysis sets the knee. During a check-in burst check frames go first
(`interactive` priority) and mid-exam identity samples wait (`background`), which is why the whole-run sample
p95 grows first while check-ins stay fast; with check-ins at 13/s (N=800 in one minute) check frames queue too.

### 5.3 Maximum identity-sample throughput (one instance)
150 candidates sending samples back to back (`SAMPLE_SEC=1`), steady phase:

| vision workers | samples/s | sample p50 | heartbeat p95 meanwhile |
|---|---|---|---|
| 3 (default on 4 vCPU) | **52.6** | 2.4 s (queue) | 12 ms |
| 4 (`VISION_WORKERS=4`) | 58.6 | 2.1 s | 22 ms |

In-process inference before the change reached 14–24 analyses/s in a micro-benchmark on the same VM while
holding the event loop (p99 event-loop delay 60–120 ms). Per analysis a worker spends ≈ 50 ms CPU (§3.5); a
single unloaded analysis takes ≈ 60–65 ms end to end (≈ 50 ms before, when one request could use 4 intra-op
threads — the only number that got slightly worse).

### 5.4 Resource use (after)
At N=1,000 (817 in the exam, one dashboard): server process ≈ 1.95 vCPU (vision ≈ 1.35, event loop ≈ 0.6,
event-loop utilisation 0.85 during the ramp), Postgres ≈ 0.25 vCPU, load generator ≈ 0.2 vCPU; RSS ≈ 700 MB
(≈ 370 MB before; each vision worker ≈ 100 MB). Postgres: 89 % of `exam_sessions` updates HOT, 0 pool waiters.
Realtime with one dashboard at N=500: ≈ 37 session summaries/s + 30 events/s + 14 identity checks/s, loaded in
batches (measured with the earlier 30 s keepalive: ≈ 7 summaries per minute per candidate; the keepalive is now
10 s, adding ≈ 4 summaries per minute per watched candidate — still batched per organisation).

## 6. Sizing guidance

Revised for identity v2 (2026-09-25, §7). The identity-v1 figures (≈ 250 candidates per vCPU, ≈ 800–1,000 per
4-vCPU instance) no longer apply. Face analysis now sets the size of a deployment. The request path (heartbeats,
answers, events) and Postgres are far from their limits at these candidate counts.

Per concurrent candidate at the default v2 policy (§7):

| | analysed frames/s | server CPU per candidate-second |
|---|---|---|
| start-up window (first 180 s after the exam starts or resumes) | 0.5 (3-frame burst every 6 s) | ≈ 45 ms |
| steady state (a burst every 15 s) | 0.2 | ≈ 18 ms |
| identity v1, for comparison | 0.033 | ≈ 2.7 ms |

A check-in adds ≈ 5.5 frames (≈ 0.5 s CPU; up to 24 frames in poor light).
- An analysed frame costs ≈ 85 ms of server CPU, of which ≈ 76 ms is the analysis (§7.4).
- A frame from the v2 client (a face crop of up to 720×720) costs ≈ 1.2× a load-test frame.
- One 4-vCPU instance (3 vision workers) analyses ≈ 35 load-test frames/s, i.e. **≈ 29 client frames/s**.

Planning at ≤ 75 % of that:

| deployment (default `VISION_THREADS` = CPUs − 1) | everyone starts together (scheduled exam) | steady state (all past their first 3 minutes) |
|---|---|---|
| per vCPU | **≈ 11** | ≈ 27 |
| 2 vCPU instance (1 vision worker) | ≈ 15 | ≈ 35 |
| 4 vCPU instance (3 vision workers) | **≈ 45** (knee ≈ 58; measured ≈ 70 with test frames) | ≈ 110 (knee ≈ 145; measured ≈ 175) |
| 8 vCPU instance (7 vision workers), or two 4-vCPU instances | ≈ 80–100¹ | ≈ 200–250¹ |

¹ Extrapolated from the 4-vCPU measurement; 3 → 4 workers gave +23 % in isolation, not +33 %, so scaling with
cores is sub-linear. Verify on your hardware with `e2e/scripts/load-test.ts` (§7.1).

The event loop (≈ 0.7 ms/s per candidate) would saturate around 1,400 candidates. With v2 an instance runs out
of face analysis long before that, so grow by vision workers (a bigger instance) or by instances.

* **The start-up window is the peak.** Scheduled exams start everyone within a minute or two, so for 3 minutes
  every candidate sends a 3-frame burst every 6 s: size for the "starts together" column.
  - *Staggered starts:* with starts spread evenly over S minutes (S ≥ 3), the peak is ≈ (0.2 + 0.9 ÷ S) frames/s
    per candidate. S = 10 gives 0.29 frames/s and ≈ 75 candidates per 4-vCPU instance; S = 30 gives 0.23 and
    ≈ 95.
  - *Resumes:* a resume (after a pause or reconnect) opens a new start-up window for that candidate.
  - *Check-ins:* a check-in is small (≈ 5.5 frames) next to the 90 frames of the start-up window after it. So one
    4-vCPU instance on its own absorbs only ≈ 14 new candidates per minute, not ≈ 8 check-ins per second as with v1.
* **Beyond capacity** (measured, §7.2):
  - `server overloaded (face analysis queue long)` appears in the log first;
  - identity bursts then wait seconds (the client's cadence stretches);
  - then frames answer 503 `vision_busy` (retried, then kept in the client's outbox);
  - check-ins slow to minutes, which delays exam starts;
  - heartbeats, answers and events stay fast throughout.
* **Cheaper policies** scale demand linearly (`burstSize`, `startupIntervalSec`, `startupWindowSec`,
  `periodicCheckIntervalSec`; §7.6). Each costs accuracy or reaction time; decide per exam.
* **When to add instances**: when the `server overloaded (…)` warning (lib/load-monitor.ts, OPERATIONS §5)
  keeps appearing, when identity samples or check frames answer 503 `vision_busy`, or when you plan for more
  than the table above. Scale out (N instances behind a load balancer) or up (more vision workers).
* **Redis** (`REDIS_URL`) is required as soon as there is more than one instance: staff realtime fans out
  through it and rate limits are shared. It also tells each instance whether any staff dashboard is open
  anywhere (`PUBSUB NUMSUB`), so instances without watchers do no realtime work. Load is light (one small
  message per realtime update).
* **Postgres**: ≈ 1.5 queries per candidate-second for the request path, plus ≈ 12 per analysed frame. Measured
  (§7.2): ≈ 0.15 vCPU per 4-vCPU instance at full face-analysis load; 2 vCPU / 4 GB serves many instances. Connections =
  instances × `PG_POOL_MAX` (+ scripts); keep below `max_connections` (default 100). A co-located Postgres over
  its Unix socket (`?host=/var/run/postgresql`) costs the server ≈ 35 % less CPU per query than TCP. With
  PgBouncer in transaction mode enable `max_prepared_statements` (the candidate-auth query is prepared).
* **`VISION_THREADS`** (default CPU count − 1, max 8): CPU threads for face analysis, one single-threaded
  worker each (best throughput per core). Set it to the CPU count on dedicated vision-heavy instances whose
  Postgres is elsewhere (identity v1: +13 % throughput in the server on 4 vCPU; identity v2: 3 → 4 workers
  +23 % analysis throughput in isolation, §7.4), lower it when the host also runs other services.
  `VISION_THREADS_PER_WORKER` > 1 lowers single-image latency at the cost of throughput. `VISION_NICE`
  (Linux, default 0) lowers the vision threads' priority so request handling wins under CPU saturation — useful
  on a dedicated host, harmful on a shared one (other processes then win over vision too).
  `VISION_WORKERS=0` runs inference on the event loop (tools only).
* **`PG_POOL_MAX`** (default 20): 20 was never exhausted once inference left the event loop (0 waiters up to
  N=1,200, and in every identity-v2 run up to N=500). Raise it only if the overload warning names the database pool while Postgres itself has spare CPU;
  more connections do not make a CPU-bound event loop faster. `PG_STATEMENT_TIMEOUT_MS` (default 60 s) stops a
  runaway statement from holding a connection and row locks.
* **Memory**: ≈ 400 MB + ≈ 100 MB per vision worker; ≈ 0.7 GB at 1,000 candidates on 4 vCPU.

## 7. Identity v2 (re-measured 2026-09-25)

Identity v2 analyses far more frames per candidate, and each frame costs more. §1–§5 above are the identity-v1
measurements. They still hold for the request path (heartbeats, answers, events), but not for face analysis,
which is now the limit well before the request path is. §6 is revised accordingly.

| per candidate | identity v1 | v2 start-up window (first 180 s after a start / resume) | v2 steady state |
|---|---|---|---|
| identity sample | 1 frame every 30 s | burst of 3 frames every 6 s (plus one burst at once, trigger `exam_start`) | burst of 3 every 15 s |
| analysed frames/s | 0.033 | **0.5** (15×) | **0.2** (6×) |
| check-in | 3 frames | ≥ 5 frontal frames while `progress.frontalNeeded > 0` (mean 5.5 measured, up to 24 in poor light) | — |
| CPU per face frame (640×480, one worker, §7.4) | 39.8 ms (v1 pipeline) | 75.7 ms (1.9×) | 75.7 ms |

The server may shorten the interval (`nextSampleInMs`: 2.5 s while the evidence is `suspect`, 5 s while
`monitoring`, ≤ 10 s after an unusable sample). With the test photos the evidence stayed `consistent`, so no
interval was shortened in these runs. Candidates in a dim room, or during a real swap, add to the figures below.

### 7.1 Method

As §2, with these differences. Server bundle built 2026-09-24 23:13 UTC from commit `f7422f4`; the server
sources are identical in `1cb71a9` / `5889d2d`, which change only the load-test script. Each run got a fresh
database and a freshly started server (`node dist/main.js`, default settings: 3 vision workers × 1 thread,
`PG_POOL_MAX=20`, no Redis) and no staff dashboard (`STAFF_WS=0`). The same 4-vCPU VM, with Postgres 16 and the
load generator on it. Each run started with a 1-min load average < 1.0, except the first three, which ran back to
back from 0.2–2.6 with nothing else running. CPU per process and the box's load average were sampled every 5 s
from `/proc`. CPU not accounted for by server + Postgres + generator averaged ≤ 0.12 cores over every run reported here
(≤ 0.18 in any phase). One run disturbed by another job (≈ 0.8 cores) was discarded and repeated.

```bash
# v2 client cadence (default): bursts of 3 sent concurrently, exam_start burst, 6 s for 180 s, then 15 s,
# nextSampleInMs honoured, heartbeat identitySample requests honoured, adaptive check-in frames
cd e2e && BASE=http://127.0.0.1:8097 STAFF_EMAIL=perf@example.com STAFF_PASSWORD=PerfTest12345 \
  N=150 RAMP_SEC=60 DURATION_SEC=360 FACES_DIR=/path/to/face/jpegs npx tsx scripts/load-test.ts
# identity-v1 client (1 frame every 30 s, fixed check-in frames) on the same server, for comparison
CADENCE=v1 N=500 RAMP_SEC=60 DURATION_SEC=240 STEADY_FROM_SEC=150 ... npx tsx scripts/load-test.ts
```

Check-ins are spread over the 60 s ramp. The run reports three phases:
- **whole run**;
- **start-up**: every candidate is inside its 180 s start-up window, from the last start to the first start + 180 s;
- **steady**: every candidate samples every 15 s, from the last start + 195 s.

Frames are the §2 test photos (640×480 JPEG q80, ≈ 30 KB). The v2 client sends face-centred crops of up to 720×720
at q0.92 (≈ 88 KB), which cost ≈ 1.2× more per frame (§7.4), so real capacity is ≈ 1/1.2 of the measured figures.
The sizing in §6 includes that factor. About 10 % of check-ins end in `retry` ("We could not verify your identity
from these images") because of the photo set, not the load; those candidates do not start. That is why
"checked in" is below N.

### 7.2 Results (v2 cadence)

p50 / p95 in ms. "Refused" = still 503 `vision_busy` after the client's 3 retries.

| N (checked in) | phase | heartbeat | answer | events | identity frame | burst (3 frames) | analysed frames/s | server CPU (cores) | load avg 1 min, mean (max) |
|---|---|---|---|---|---|---|---|---|---|
| 60 (54) | start-up | 3 / 9 | 5 / 12 | 6 / 14 | 101 / 132 | 111 / 142 | 26.4 | 2.29 | 2.62 (3.28) |
| | steady | 3 / 96¹ | 4 / 61¹ | 5 / 81¹ | 104 / 259¹ | 113 / 345¹ | 10.7 | 0.98 | 1.39 (2.12) |
| 100 (91) | start-up | 4 / 12 | 6 / 15 | 7 / 18 | **1,768 / 2,352** | 1,800 / 2,371 | 35.1 | 2.99 | 3.84 (4.65) |
| | steady | 3 / 8 | 4 / 11 | 5 / 12 | 100 / 131 | 110 / 141 | 18.0 | 1.59 | 2.68 (3.18) |
| 150 (136) | start-up | 4 / 16 | 7 / 24 | 8 / 33 | **5,963 / 8,677** | 5,990 / 8,709 | 34.1 | 2.96 | 3.86 (5.12) |
| | steady | 3 / 10 | 5 / 14 | 6 / 14 | 111 / 181 | 124 / 204 | 27.1 | 2.39 | 3.49 (4.99) |
| 200 (182) | start-up | 4 / 13 | 7 / 18 | 7 / 21 | **7,685 / 13,807** | 9,540 / 14,351 | 34.0 | 2.99 | 4.87 (5.41) |
| | steady | 4 / 11 | 6 / 14 | 7 / 17 | **509 / 889** | 540 / 915 | 35.1 | 2.98 | 4.43 (4.95) |
| 500 (447) | whole run² | 8 / 28 | 12 / 44 | 14 / 53 | **6,901 / 18,774** | 11,814 / 21,229 | 31.5 | 3.05 | 4.37 (5.58) |

| N | check frame (whole run) | refused after retries | 503s retried |
|---|---|---|---|
| 60 | 105 / 161 | 0 | 0 |
| 100 | 127 / 180 | 0 | 0 |
| 150 | 189 / 1,545 | 0 | 0 |
| 200 | 1,538 / 4,707 | 196 identity frames (138 of 4,527 bursts incomplete) | 2,875 |
| 500 | **8,891 / 21,927** | 9,537 of 20,478 identity frames (47 %), 1,194 of 3,888 check frames; 4,791 of 6,826 bursts incomplete | 45,688 |

Postgres used 0.05–0.34 cores and the load generator 0.02–0.17 cores.

¹ One disk stall at t+385–395 s (Postgres checkpoint in progress): answers, events, heartbeats and samples all
slowed together for ≈ 1 s while the box was ≈ 70 % idle. Outside that 20 s window the 10-s p95s were heartbeat
≤ 14 ms and identity frame ≤ 250 ms. The v1-cadence run shows a similar single ≈ 0.8 s blip; it is the VM's disk,
not the load.
² At N=500 the check-ins alone took minutes, so there is no clean start-up or steady phase.

Reading the tables:
- **Face analysis is the only limit.** The request path stays fast even at N=500 with analysis saturated:
  heartbeat p95 ≤ 28 ms, answers ≤ 44 ms, events ≤ 53 ms.
- **Throughput.** Saturated, one instance analyses ≈ 34–35 frames/s (31.5 at N=500, where it also answers
  thousands of 503s): 3.0 cores of server CPU, ≈ 85 ms per analysed frame over all threads.
- **Beyond capacity** it degrades in this order:
  1. Bursts queue for seconds. The client schedules its next burst after the answer, so the effective interval
     stretches (a closed loop).
  2. The vision queue fills (`server overloaded (face analysis queue long)` in the log, `visionQueued` 255–510)
     and frames get 503.
  3. Check-ins wait: check frames are served first, but they share the interactive queue with `exam_start`
     bursts and alternate with overdue identity samples. At N=500 a check-in took minutes (check frame p95 22 s),
     so candidates started late.
- **Recovery after the peak.** The backlog drains as the start-up windows end. At N=150 the windows ended between
  t+182 and t+246 s; identity p95 was ≈ 5–6 s until t+200 s and < 0.3 s from t+250 s.

### 7.3 v1 cadence on the current code (N=500): more work per frame vs more frames

The same server with the identity-v1 client: 1 frame every 30 s, and the check-in sends `frontalFramesRequired`
frames, now 5 (was 3). Steady phase = t+150…300 s, after the check-in backlog.

| N=500 | identity v1 code (§1, whole run) | current code, v1 cadence |
|---|---|---|
| check frame (ramp) | 68 / 98 | **4,138 / 7,843** |
| identity sample (steady) | 66 / 96 | 95 / 142 |
| heartbeat / answer / events (steady) | 3 / 8, 5 / 12, 6 / 14 | 3 / 7, 4 / 10, 5 / 12 |
| analysed frames/s (steady) | — | 15.1 |
| server CPU (steady) | — | 1.46 cores (ramp: 3.03) |
| load avg 1 min (steady) | — | 1.48 (max 2.56) |
| refused | 0 | 0 |

- **More work per frame.** Per-frame cost is 1.9× (§7.4), and an isolated sample takes 95 ms instead of 66 ms.
  At the v1 frame rate the steady state is still comfortable (≈ 45 % of vision capacity at 452 candidates).
- **More check-in frames.** 5 frames instead of 3 at 1.9× the cost means a 500-candidate check-in ramp over 60 s
  (8.3 check-ins/s ≈ 42 frames/s) no longer fits in ≈ 35 frames/s. Check-ins queue even with the v1 cadence.
- **More frames overall.** The v2 cadence multiplies analysed frames per candidate by 15 in the start-up window
  and by 6 after it. Together with the per-frame cost, face-analysis CPU per candidate is ≈ 28× v1 during start-up
  and ≈ 11× afterwards. This, not the per-frame cost, is what moves the knee from ≈ 1,000 to ≈ 70–175 candidates.

### 7.4 Where the time goes per analysed frame

`analyze()` with the identity-sample options (embedding + face crop), one onnxruntime thread (= one vision
worker), in-process, quiet box, 40 face photos × 3 repetitions. Inference time was split per model by wrapping
`InferenceSession.run` (scratch script, not committed); the vision code was not changed.

| ms per frame | 640×480 q80 (30 KB) | 1280×720 q92 (112 KB) | 720×720 face crop q92 (88 KB)³ |
|---|---|---|---|
| **v2 default** (mirrored detection on, flip TTA on) | **75.7** | **89.8** | **92.9** |
| mirrored detection off, flip TTA on | 66.4 | 77.9 | 78.7 |
| mirrored detection on, flip TTA off | 52.3 | 64.8 | 68.5 |
| both off | 40.6 | 47.8 | 50.0 |
| v1 pipeline (single view, no mirror, no low-light pass) | 39.8 | 49.0 | 49.2 |

³ What the v2 client sends: a square face crop of 2.4 × the face size at native resolution, ≤ 720 px
(`frames.ts faceCropRect`).

v2 default at 640×480:
- YuNet 2 runs × 8.1 ms (the frame and its mirror image);
- SFace 1.98 runs × 24.2 ms (the frame and its flip; the one poor-bucket photo takes a single denoised view);
- decode 2.9 ms;
- the rest (statistics, 2 letterbox packs, the flop, alignment, quality, face-crop JPEG) 8.8 ms.

At 1280×720: YuNet 2 × 8.5 ms, SFace 2 × 25.2 ms, rest 22.6 ms (decode 5.3 ms, then a resize to 640 px for each of
the 2 detector passes, and the crop).

| v2 feature | extra CPU per frame |
|---|---|
| flip TTA (a second SFace run, good / fair frames) | +23–25 ms (+31 % at 640×480) |
| mirrored YuNet detection (`symmetricPose`, every frame with a face) | +9 ms at 640×480, +12–14 ms at 1280×720 / 720×720 (second resize + flop + pack + YuNet run) |
| low-light second detection (face-less frames only) | a face-less frame costs 33 ms instead of 13 ms |
| 3×3 denoise instead of flip (poor frames) | none: one SFace run on the denoised crop instead of two |

Worker-pool throughput (analysis only, 12 concurrent requests, 640×480):
- 3 workers: v2 **37.2–37.5 analyses/s**, v1 pipeline 68.2/s;
- 3 workers with 720×720 crops: 31.4/s;
- 4 workers: 46.1/s.

In the server under load the 3 workers deliver ≈ 34–35 frames/s: the event loop, Postgres and the generator
share the 4th vCPU.

### 7.5 Knee

The knee is where p95 stays ≤ 1 s with no refusals. Vision capacity is ≈ 35 frames/s per 4-vCPU instance with
the test frames, ≈ 29 with real client crops.

| | fine | saturated | capacity-bound knee (35 frames/s ÷ demand) |
|---|---|---|---|
| start-up window (0.5 frames/s per candidate) | 54 active: identity p95 132 ms, 75 % of capacity | 91 active: p95 2.4 s; 136: 8.7 s; 182: 13.8 s + 503s | **≈ 70 active candidates** |
| steady state (0.2 frames/s per candidate) | 91 active: p95 131 ms; 136: p95 181 ms (77 %) | 182 active: p95 889 ms, queueing at 100 % | **≈ 175 active candidates** |
| check-in ramp (check frame p95) | 1 check-in/s: 161 ms; 1.7/s: 180 ms | 2.5/s: 1.5 s; 3.3/s: 4.7 s; 8.3/s (N=500 in 60 s): 22 s | a check-in is only ≈ 5.5 frames; the load is the start-up bursts of those who already started (90 frames each over 180 s) |

With real client crops the knees are ≈ 58 (start-up) and ≈ 145 (steady). Planning at ≤ 75 % of capacity gives
**≈ 45 candidates per 4-vCPU instance when everyone starts together** (≈ 11 per vCPU) and **≈ 110 in steady
state** (≈ 27 per vCPU). Identity v1 planned ≈ 250 per vCPU (≈ 800–1,000 per instance).

### 7.6 Optimisation options (measured; not applied)

Accuracy-neutral (identical model inputs):

| idea | measured gain | notes |
|---|---|---|
| Mirrored pass: flip the already-packed 640×640 detector tensor instead of resizing, flopping and packing the frame again | −1.3 ms (640×480), −4.4 ms (1280×720), −5.9 ms (720×720 crop) per face frame ≈ **−2 % / −5 % / −6 %** | Bit-identical YuNet input (verified). Simplest form: keep the resized detector image from the first pass. |
| Batch-2 inference (flip-TTA views in one SFace run; frame + mirror in one YuNet run) | **none**: SFace 35.8 → 35.6 ms, YuNet 15.5 → 16.4 ms for the pair (1 thread) | Needs model copies with a symbolic batch dimension; outputs identical. Not worth it. |
| `VISION_THREADS=4` (4 workers instead of 3) on an instance whose Postgres runs elsewhere | 37.5 → 46.1 analyses/s in isolation (+23 %); in the server with a co-located Postgres identity v1 gained +11 % | Operational setting, no code change. |

Pending changes from the review (not in the measured build):
- burst frames keep images only for the representative frame;
- `checkProgress` stops re-decrypting all of a check's frames on every new frame.

Both cut main-thread and disk work (≈ 9 of the ≈ 85 ms of server CPU per analysed frame, plus quadratic
decryption in long adaptive check-ins), not the analysis itself. Expect a few percent (≤ 10 %) more capacity and
faster long check-ins. Re-run §7.1 after they land.

Trade-offs for the product owner. These are not neutral: each changes accuracy or reaction time. Demand scales
linearly with these settings:

| setting | effect |
|---|---|
| `burstSize` 3 → 2 | −33 % frames |
| `startupIntervalSec` 6 → 12 | −50 % start-up demand |
| `startupWindowSec` 180 → 90 | halves how long the peak lasts |
| `periodicCheckIntervalSec` 15 → 30 | −50 % steady demand |
| flip TTA off | −31 % per frame (EER in fair light 0.30 → 0.34 %, `accuracy/identity-v2.md` §5) |
| mirrored detection off | −12 % per frame (the ±1.5× yaw asymmetry returns in liveness and the pose gate) |
