# Scrolling between days: where the time actually goes

Two questions, one investigation:

1. **Would persisting closed days in the browser (IndexedDB) make day-scrolling
   faster?** No — see [the appendix](#appendix-the-indexeddb-question). It saves
   ~1–6 ms on a path that already costs 150 ms for reasons that have nothing to
   do with storage.
2. **What is actually blocking it?** Four things, all in `app.js`, all free to
   fix, none of them the provider.

All figures: 2026-08-13, live server on `localhost:8080` (the default at the
time; current builds use `8780`), real provider (2 merged), Chrome 151 over CDP.

## The blockers, ranked by what they cost you

### 1. The 120 ms debounce is on the cache-hit path — ~145 ms per hop, paid for nothing

Hopping between two days **already held in the client `dayCache`**, zero network
required:

| | measured |
|---|---|
| hop via `commitWindow` (6 hops, A↔B, both cached) | **153, 159, 178, 179, 181, 191 ms** |
| the same paint with the cache read in front of the debounce | **7, 9, 11, 13, 26, 55 ms** |
| network requests issued during those 6 hops | 1 |

**A day you already have takes ~15× longer to appear than it costs to draw.**

The cause is placement: `loadTimeline`'s `dayCache.get(day)` fast path
(`app.js:427`) lives *inside* the callback that `commitWindow` schedules 120 ms
out (`app.js:519`). The debounce exists to stop held arrows from spawning five
subprocesses — a real problem — but it is applied before we check whether a
request is needed at all. A cached day needs no debouncing, because it issues
nothing to debounce.

**Fix:** check the cache in `commitWindow`, synchronously, ahead of the timer.
Only schedule the debounced fetch on a miss. This is the single change that makes
scrolling through loaded history feel immediate, and it is worth more than every
storage idea in this document combined.

### 2. Every cold hop spawns two providers, not one

Stepping back through history, re-stepping as soon as each day lands. Instrumented
at `window.fetch`:

```
day=2026-07-26  t=4914ms  351ms
day=2026-07-26  t=5191ms  303ms   <-- same day, again
day=2026-07-25  t=5392ms  325ms
day=2026-07-25  t=5671ms  324ms   <-- again
day=2026-07-24  t=5846ms  492ms
day=2026-07-24  t=6125ms  425ms   <-- again
```

`schedulePrefetch` skips a neighbour when `dayCache.has(d)` (`app.js:747`) — a
**completed**-only check. There is no in-flight set. So the prefetch that fires
400 ms after day D settles re-issues D−1, which the user's own arrow key already
put in flight 280 ms earlier and which has not returned yet.

**The prefetcher built to make scrolling fast is doubling the provider load
during a scroll** — and both spawns then compete for the same machine.

**Fix:** track requested days, not just returned ones. A `Set` of days with a
request outstanding, consulted by both `schedulePrefetch` and `loadTimeline`,
removes the duplicate and needs no other structural change.

### 3. Prefetch depth is 1, and it starts 400 ms after settle

`schedulePrefetch` warms `[D−1, D+1]`, takes the first uncached one, and
`break`s — one day, one at a time, after `PREFETCH_IDLE_MS = 400`.

So the free cadence is `400 ms + one spawn` ≈ **1.5–2 s per day**. Arrow-key
repeat is ~30 ms. **You get exactly one free hop, then you are back to full cold
cost for every subsequent day**, which is what makes a scroll feel fine for one
press and then stall.

**Fix:** depth 2–3 in the direction of travel. Scrolling has a direction and it
is knowable — the last `stepDay` delta. Warming D−2 and D−3 while the user reads
D−1 is the same total work, moved off the critical path. Keep the one-at-a-time
serialization; the point is to start earlier, not to fan out.

### 4. Prefetches are untracked and uncancellable

They use a bare `fetch()` (`app.js:748`) rather than the `inflight`
`AbortController`, so a day change cannot abort them. Holding the arrow key
across 5 days:

```
day=2026-07-12  t=16636ms    3ms
day=2026-07-11  t=17041ms  450ms   <-- orphan: user is already past this day
day=2026-07-07  t=18593ms  650ms   <-- the day actually wanted
```

The 450 ms orphan runs concurrently with the request that matters. This is the
starvation trade-off recorded in `app.js:405-420` applied one notch too broadly:
a **poll** must never abort work in flight, but a **prefetch** for a day the user
has visibly scrolled past has no such claim.

**Fix:** give prefetches their own `AbortController` and abort on day change.
Distinct from the poll rule, which stays.

### 5. Underneath all of it: the spawn

| day | bytes | cold (`X-Cache: miss`) | warm (`hit`) |
|---|---|---|---|
| 2026-08-03 | 71 KB | **838 ms** | 0.7 ms |
| 2026-08-04 | 265 KB | **1630 ms** | 0.8 ms |

A day nobody has opened costs 838–1630 ms and **nothing in this document removes
that** — caching only ever helps the second visit. That is
[incremental-poll.md §3](incremental-poll.md) (a seeking provider), and it is
still the largest single number in the system.

But note what #1–#4 mean: on a scroll through history you have *already loaded*,
the provider is not involved at all, and the dashboard is still spending 150 ms a
hop. Fix those first.

## Results

All four are implemented. Re-measured the same way, against a freshly started
server (so the server `dayCache` is genuinely cold):

| scroll | before | after |
|---|---|---|
| hop through days already loaded | 153–191 ms | **8.8–13.2 ms**, 0 requests |
| 4-hop scroll into cold history | `[134, 477, 454, 618]` ms, **8 requests for 4 days** | `[2, 1, 503, 566]` ms, **2 requests for 4 days** |
| duplicate requests during that scroll | every day fetched twice | **none** |
| held arrow across 5 days | 1115 ms, 1 real + 1 orphan spawn | **815 ms, 1 spawn** |
| prefetch reach after settling | 1 day | **3 days**, in the direction of travel |

The first two hops of the cold scroll now cost **2 ms and 1 ms** — those days
were already warmed by the depth-3 walk, which is the whole point of #3. Only
hops 3 and 4 reached past the warmed edge and paid a real spawn.

Cached hops are now render-bound: `render()` is 5–27 ms depending on lane count
(1075 lanes = 27.4 ms), so ~10 ms is the floor without touching the renderer.
That is inside one frame at 60 Hz.

Verified separately, since neither path shows up in a happy-path scroll:

- **Abort.** A cold request for 2026-06-20 in flight, then a jump to 2026-05-02:
  the first request reports `ABORTED` at 179 ms and only the wanted day
  completes.
- **Adoption.** Stepping onto a day the prefetcher already has in flight
  promotes that request from speculative to committed and issues **one** request
  for it, not two. This is the mechanism that removes the duplication in #2 —
  the request is joined, not restarted and not raced.
- **The live window is untouched.** Today is still never cached, still polls
  (2 polls in 9 s, cadence measured from completion), and a speculative request
  does not hold the poll off.

`node --test web/model.test.js web/states.test.js` — 213/213 pass. `go test
./...` — all packages pass.

---

## Appendix: the IndexedDB question

Two closed-day caches already exist — `daycache.go` (64 days, 10 min TTL,
in-process) and `app.js:348`'s `Map` (12 days, dies on reload). IndexedDB adds
only *persistence*, so the question is what persistence is worth.

### Retrieval is not the bottleneck

Medians of 7, in-page:

| day | bytes | lanes | fetch→text (warm) | `JSON.parse` | IDB read (text) | IDB read (object) | `render()` |
|---|---|---|---|---|---|---|---|
| 08-03 | 71 KB | 19 | 2.2 | 0.3 | 0.2 | 0.4 | 15.2 |
| 08-04 | 265 KB | 171 | 2.3 | 1.0 | 1.3 | 4.0 | 12.3 |
| 08-05 | 1.20 MB | 1075 | 6.9 | 4.9 | 1.3 | 8.8 | 27.4 |
| 08-06 | 524 KB | 542 | 2.9 | 2.4 | 2.3 | 5.1 | 8.3 |
| 08-07 | 439 KB | 493 | 2.7 | 1.7 | 1.0 | 3.7 | 5.2 |
| 08-12 | 112 KB | 27 | 1.0 | 0.2 | 0.2 | 0.5 | 7.2 |

On the heaviest day on record (08-05): warm server = 11.8 ms total; IndexedDB as
text = 6.2 ms; IndexedDB as parsed object = 8.8 ms (structured clone of 1075
lanes costs more than V8's parser — store the string). **A 5.6 ms saving against
a 27.4 ms render, inside a 150 ms hop and a 380 ms reveal.**

Storage is a non-issue: 10 days = 2.61 MB against an 8.59 GB quota. `localStorage`
is the wrong door (5 MB, synchronous); IndexedDB has room to spare.

### Where it would genuinely win, and why that is still not the answer

The saving is never in the bytes — it is in not paying the spawn. So it applies
only where the client holds a day the server does not: a reload after the
server's 10 min TTL expires, returning the next day, or a `systemctl restart`.
Those are real, and worth 838–1630 ms → ~6 ms.

But that band is *"the server cache's lifetime is too short"*, and the cheaper
fix is to make the server cache outlive its process: **persist `daycache` to
disk**. It covers every one of those cases including restart, serves every
browser and tab, and needs no client-side schema versioning, quota handling, or
migration — reusing invalidation logic `daycache_test.go` already covers. The
envelope is already a `[]byte` where it is stored.

There is also a correctness cost specific to the browser. `daycache.go`'s TTL is
load-bearing: a session overlapping midnight keeps extending its lane in
yesterday's envelope, and the 10 min TTL bounds how wrong that gets. An
IndexedDB entry outlives the process, converting a bounded staleness into an
unbounded one — so it needs a *stronger* invalidation story than the TTL whose
expiry motivated it, in a file with no unit tests.

If you want it anyway, the only correct shape is stale-while-revalidate: paint
from IndexedDB, revalidate in background, re-render only on byte difference
(`settleTimeline`'s per-day guard at `app.js:477` already makes the unchanged
case free). It buys one thing the server cannot: history when the server is down.

### Incidental finding

`dayCacheMax`'s comment claims *"Each envelope is O(100KB), so this is a few tens
of MB worst case."* 2026-08-05 is **1.20 MB** — 12× the assumed size. At 64
entries the real worst case is ~77 MB RSS, against a service whose peak is
currently 402 MB. Not urgent, but the comment states a bound the code does not
hold to.

## Reproducing

```bash
curl -s -o /dev/null -w '%{time_total}\n' -D - \
  "http://localhost:8780/api/timeline?day=2026-08-04" | rg -i '^x-cache'
```

In-page figures: drive headless Chrome over CDP (see the repo memory note),
navigate to `http://localhost:8780/`, and instrument `window.fetch` while calling
`commitWindow` / `stepDay` — `app.js` top-level bindings (`dayCache`, `dataDay`,
`win`, `settleTimeline`) are reachable from `Runtime.evaluate`.
