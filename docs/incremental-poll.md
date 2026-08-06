# The poll re-derives the whole day, three times a minute

`POLL_MS = 3000` and a live fetch costs ~1.4 s, so the machine spends roughly
half its wall-clock re-deriving a day it already has. This documents what that
actually buys (almost nothing), where the time goes, and the shape of the fix:
**pass mutations through the poll, not the whole state.**

Nothing here is implemented. `perf/instant-day-switch` fixed the *switching*
path — see [instant-day-switch.md](instant-day-switch.md) — and gated the poll
to the live window, which removed the waste on closed days entirely. What
remains is the live window, where the poll is genuinely needed and genuinely
wasteful.

## What a poll actually changes

Two polls of today, 8 s apart, against the real store (2 merged providers):

```
poll A: 476,596 bytes in 1.42s
poll B: 476,564 bytes in 1.40s

lanes: 524 total | 0 added | 0 removed | 6 modified | 518 byte-identical
  of the 6 modified lanes, 6 changed ONLY at their trailing edge
  intervals appended: 0 | pre-existing intervals rewritten: 6

payload B: 476,564 bytes
  re-sent unchanged : 437,051 (91.7%)
  modified lanes    :  37,352  (7.8%)
  new lanes         :       0  (0.0%)
```

**98.9% of lanes were byte-identical.** The six that moved did not even gain an
interval — their trailing interval's `end` was extended. The true mutation for
those 8 seconds is on the order of six timestamps; we transferred 476 KB and
burned 1.4 s of CPU to deliver it.

This is exactly what a live activity log should look like: history is immutable
once written, and only the trailing edge moves. The poll is built as though the
whole day were volatile.

## Where the 1.4 s goes

Measured directly, same day:

| component | cost |
| --- | --- |
| `switchboard-ctl timeline --json --day` | **0.77 s** |
| the `--plan-window` surcharge on that same call | **+0.55 s** |
| `arachne-switchboard-ctl timeline --json --day` (runs in parallel) | 0.02 s |
| dashboard `Parse` → `Merge` → `Marshal` of 679 KB → 476 KB | ~0.1 s |
| **total at the HTTP boundary** | **~1.4 s** |

The cost is flat in output size — a 35 KB day measured 1.96 s while a 476 KB day
measured 1.40 s — so it is a **scan**, not serialization. The store is ~747 MB
across 36 project directories, and every poll walks enough of it to reconstitute
a day from scratch.

## Three levers, cheapest first

### 1. Stop paying `--plan-window` on the timeline cadence

**0.55 s — 39% of every live poll — for a rolling 5 h aggregate that moves
slowly.** It is requested on the timeline's 3 s cadence purely because it rides
the same argv. Fetch it on the plan cadence (15 s) instead and splice it into
the envelope, or give it its own endpoint.

No contract change, no risk, no new failure mode. This should land regardless of
what happens to the rest of this document.

### 2. Conditional requests (`ETag` / `If-None-Match`)

Tempting and insufficient — recorded so it does not get proposed as the answer.
Hashing the envelope server-side and answering `304` saves the 476 KB transfer
and the client-side parse, but **not the provider spawn**, which is ~95% of the
cost. The dashboard already detects "nothing changed" (`settleTimeline`'s
per-day text guard) — it just pays 1.4 s to find out. A `304` would move that
discovery from the client to the server without making it cheaper.

Worth having for bandwidth once deltas exist. Not a latency fix.

### 3. A cursor in the provider contract — the actual fix

Extend the contract with an optional cursor so a provider can answer "here is
what changed since you last asked" instead of "here is the day".

```
<your-exec…> [--dir D] [--day YYYY-MM-DD] [--since-cursor <opaque>]
```

Response, when a delta is possible:

```json
{
  "cursor": "<opaque, to send back next time>",
  "base_cursor": "<the cursor this delta applies to>",
  "lanes_changed": [ /* full Lane objects, only the ones that moved */ ],
  "lanes_removed": ["session-id", …],
  "summary": { /* always complete */ },
  "totals":  { /* always complete */ },
  "checksum": "<of the full reconstructed envelope>"
}
```

Design points, each forced by something real:

- **Opt-in and negotiated.** The contract is public and multi-language
  ([provider-contract.md](provider-contract.md)); Arachne is an independent
  implementation. A provider that ignores `--since-cursor` must keep working —
  the contract already requires unknown flags be non-fatal, so appending it is
  safe, but the dashboard must not *assume* a delta came back. Presence of
  `cursor` in the envelope is the signal that this provider speaks deltas.
- **Falling back to a full envelope is always legal.** Cursor too old, store
  compacted, provider restarted, anything — reply in full. This is what keeps
  the feature from being a correctness risk.
- **Lane granularity, not interval granularity.** The measurement says six lanes
  of 524 move; lane-level replacement already gives ~99% reduction. Patching
  *inside* a lane buys a rounding error for a large increase in the number of
  ways the merged state can be wrong.
- **`summary` and `totals` ship complete every time.** They are aggregates over
  the whole day and they are small. Deriving them client-side from patched lanes
  is how the numbers silently drift out of agreement with the chart.
- **The merge needs an audit.** Accumulated state can diverge from truth without
  anything looking wrong. The `checksum` lets the dashboard verify its
  reconstruction and re-sync on mismatch; a forced full sync on every day change
  and every N deltas bounds how long a divergence can live.

### The part that is not ours

**A cursor in the contract is necessary but not sufficient.** If
`switchboard-ctl` implements `--since-cursor` by scanning all 747 MB anyway and
diffing at the end, the 0.77 s stays and only bandwidth improves. The latency
win requires the provider to *seek* — exploit file mtimes and append offsets so
the read is proportional to what changed, not to the store.

That work lives in `~/Projects/switchboard`, not in this repo — the same
boundary as [the timeline data
bugs](instant-day-switch.md). The dashboard-side change is worth doing on its
own (bandwidth, client parse, merge cost), but it should not be sold as the
latency fix until the provider can seek.

## Already fixed on this branch

Two poll problems were cheap enough to fix while the switching path was open, so
they are done rather than proposed:

- **Cadence is measured from completion, not on a fixed interval.** `POLL_MS` is
  now the gap *between* polls. With `setInterval`, a provider slower than
  `POLL_MS` would have spawns queueing behind each other forever.
- **A poll never aborts work in flight.** The abort-on-issue rule that makes day
  switching correct is a starvation bug when applied to polls: one slow provider
  away, each poll would kill its predecessor at the 3 s mark and none would ever
  complete — the live view frozen, the status dot still green. Only a day change
  may abort; a poll that finds work in flight yields.
