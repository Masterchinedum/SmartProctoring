# Performance and capacity

How many candidates one SmartProctoring server instance carries, what limited it, what was changed, and how to
size a deployment. All numbers come from `e2e/scripts/load-test.ts` against a real server (real Postgres, real
YuNet/SFace inference on real face photos); the method is in §2 so every number can be reproduced.

## 1. Summary

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
* **Sizing**: plan ≈ 250 concurrent candidates per vCPU at the default 30 s identity interval and ≈ 2 check-ins/s
  per vCPU of start-up burst; details in §6.

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
batches (≈ 7 summaries per minute per candidate: events, identity decisions, 30 s keepalive).

## 6. Sizing guidance

Per concurrent candidate at the default policy (identity sample every 30 s, heartbeat every 5 s), measured:
≈ 1.7 ms/s of face analysis + ≈ 0.7 ms/s event loop + ≈ 0.3 ms/s Postgres ≈ **2.7 ms CPU per candidate-second**,
i.e. ≈ 370 candidates per fully busy vCPU. Keep ≥ 30 % headroom for check-in bursts and GC.

| deployment | concurrent candidates | check-in burst |
|---|---|---|
| 2 vCPU instance | ≈ 400 | ≈ 4 check-ins/s |
| 4 vCPU instance | ≈ 800–1,000 | ≈ 8 check-ins/s |
| 8 vCPU host | ≈ 1,800–2,000 as **two** 4-vCPU instances | ≈ 16 check-ins/s |

One instance's event loop is a single core: at ≈ 0.7 ms/s per candidate it saturates around 1,400 candidates
whatever the core count, so scale beyond ≈ 1,000–1,200 candidates per instance by adding instances, not cores.

* **Check-ins are the burst**: a check-in costs 3 face analyses (≈ 150 ms CPU) plus ≈ 30 queries. If all
  candidates start at the same minute, size for `candidates ÷ 60` check-ins/s — or stagger start times
  (e.g. open the exam 5–10 min before the start). A shorter identity interval scales the analysis cost linearly
  (15 s ⇒ ≈ 3.4 ms/s per candidate).
* **When to add instances**: when the `server overloaded (…)` warning (lib/load-monitor.ts, OPERATIONS §5)
  keeps appearing, when identity samples or check frames answer 503 `vision_busy`, or when you plan for more
  than the table above. Scale horizontally: N instances behind a load balancer.
* **Redis** (`REDIS_URL`) is required as soon as there is more than one instance: staff realtime fans out
  through it and rate limits are shared. It also tells each instance whether any staff dashboard is open
  anywhere (`PUBSUB NUMSUB`), so instances without watchers do no realtime work. Load is light (one small
  message per realtime update).
* **Postgres**: ≈ 1.5 queries per candidate-second (≈ 1,400 queries/s at 1,000 candidates) and ≈ 0.25 vCPU
  per 1,000 candidates with warm caches; 2 vCPU / 4 GB is plenty for several thousand candidates. Connections =
  instances × `PG_POOL_MAX` (+ scripts); keep below `max_connections` (default 100). A co-located Postgres over
  its Unix socket (`?host=/var/run/postgresql`) costs the server ≈ 35 % less CPU per query than TCP. With
  PgBouncer in transaction mode enable `max_prepared_statements` (the candidate-auth query is prepared).
* **`VISION_THREADS`** (default CPU count − 1, max 8): CPU threads for face analysis, one single-threaded
  worker each (best throughput per core). Set it to the CPU count on dedicated vision-heavy instances whose
  Postgres is elsewhere (+13 % throughput measured on 4 vCPU), lower it when the host also runs other services.
  `VISION_THREADS_PER_WORKER` > 1 lowers single-image latency at the cost of throughput. `VISION_NICE`
  (Linux, default 0) lowers the vision threads' priority so request handling wins under CPU saturation — useful
  on a dedicated host, harmful on a shared one (other processes then win over vision too).
  `VISION_WORKERS=0` runs inference on the event loop (tools only).
* **`PG_POOL_MAX`** (default 20): 20 was never exhausted once inference left the event loop (0 waiters up to
  N=1,200). Raise it only if the overload warning names the database pool while Postgres itself has spare CPU;
  more connections do not make a CPU-bound event loop faster. `PG_STATEMENT_TIMEOUT_MS` (default 60 s) stops a
  runaway statement from holding a connection and row locks.
* **Memory**: ≈ 400 MB + ≈ 100 MB per vision worker; ≈ 0.7 GB at 1,000 candidates on 4 vCPU.
