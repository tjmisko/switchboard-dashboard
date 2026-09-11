# Ghost lanes: the diagnosis, and why they stopped

A ghost lane is a swimlane the reader synthesized rather than observed — one it
opened because two events disagreed about when a session ended, and then never
closed. For about a week in mid-2026 they were common enough to distort a day's
totals, and diagnosing them took enough measurement that the result is worth
keeping even though the cause is fixed.

This is settled history. The producer defect behind the large majority was fixed
upstream in switchboard `e6b24ba`, *"stop a nested `claude -p` hook landing on
its parent session"*, and the affected days have since aged out of the retention
window. Nothing here needs acting on. It is kept because the *shape* recurs —
anything that reconstructs state from two independently-written event streams can
produce it — and because the measurements are what distinguish it from three
other things that look identical.

The read-side defense that remains in the tree is `internal/timeline/suspect.go`.

## The worked example

From `2026-08-05.jsonl`:

```
10:29:37.438991459  transition working → idle   dur_prev_ms=16100   ← written first
10:29:37.437833786  session_end                                     ← stamped 1.16ms earlier
```

The session ran for **19 seconds**. Two writers race at process death — the
hook-driven closing transition, and the pidfd death-watch's `session_end` — and
the death-watch stamped the earlier time while writing second.

The reader orders by timestamp. So it closes the lane on `session_end`, then
meets a later transition carrying the same `session_id`, and opens **a second
lane that nothing ever closes**. That lane stretched to the window bound and drew
as three hours of idle: unnamed, and alone in its own one-session project group.

The producer's own plausibility check did not catch it. Three hours sits under
the 4h `DefaultSuspectTrailingCap`, so the ghost was invisible until it had
already spent the day polluting the totals.

## How often, measured

Over the seven day-files `2026-07-30` → `08-05`, the signature — a `session_end`
followed in timestamp order by a later `transition` for the same session —
matches **16 times**: 1, 12, 0, 0, 0, 1, 2 per day.

Sixteen matches are not sixteen races. Measuring the gap (transition timestamp
minus `session_end` timestamp) forces the set apart:

```
min 1.16ms | median 3.3s | max 2249s (37.5 min)
```

A 37-minute gap is not two writers colliding at process death. The 16 are at
least four distinct things:

| Count | What it actually was |
|---|---|
| 1 | A genuine write-order race — the worked example above |
| 12 | Hook misattribution from a nested `claude -p` — a producer defect, now fixed |
| 1 | A legitimate resume, not a defect at all |
| 2 | Never classified individually |

- **The race** — `2026-08-05`, session `296eb0f0`, gap 1.16ms, both events on the
  **same pid** (1241937). It stands as described.
- **The resume** — `2026-07-30`, session `48c6630d`. Ended on pid 189739; the same
  conversation resumed 37 minutes later on pid 2953. It is the 37.5-minute
  outlier in the spread: a human, not a race. Its lane carries a real label, a
  full idle→working→idle cycle, focus events, and a dozen `usage_sample`s with
  genuine token deltas.
- **Unclassified** — `08-04` `6169e789` (pid 3917156, `arachne`) and `08-05`
  `1e158165` (pid 3363273, `jobfeed`).

## The twelve: hook misattribution, and which way it ran

All twelve are on `07-31`, and they are the interesting ones. The id is carried
by **two live pids at once** — e.g. `178517a7` on pid 121407 (the real
interactive session) and on pid 653188, whose cwd is
`~/.local/share/switchboard/summaries`: `session-digest`'s own `claude -p`
summarizer.

**The causal direction is the opposite of what it looks like.** The helper does
not absorb the real session's transitions. The real session takes the *helper's*
id.

`switchboard-ctl hook` identifies its caller by `getppid()`, and the daemon's
`findTrackedAncestor` walked up to the nearest **tracked** pid. A nested
`claude -p` fires `SessionStart` within milliseconds of exec, while discovery
registers it only on the next /proc scan tick (default 1s). Inside that window
the walk sailed past the helper onto its interactive parent — which then took the
helper's `SessionID`, had its `Transcript` repointed at the helper's file, and
had its pending prompts cleared by a false rotation.

The measurement that settles the direction: in **32 of the 35** ids shared across
two pids that day, the parent took the id **1–700ms before** the helper's own
`session_start`. The whole distribution sits inside one scan tick.

Note **35, not 12** — the signature is a net that catches roughly a third of the
actual bleed. One interactive session cycled through **41 distinct ids in 10.5
hours**. Five other sessions live during the same 28-minute burst absorbed
nothing at all, which is what pins the cause to ancestry rather than to load or
timing generally.

### Why this is corruption and not two real sessions

`dur_prev_ms` chains exactly across the id churn — **4999ms in, 4733ms out**. The
process never stopped working; only its `session_id` moved.

It is worth being precise about why this is *not* the case the history schema
blesses. That contract — "one session can span two processes; after a
`session_end`, the same id reappearing is a second run and a second lane" —
describes a **sequential** case: a resume, after the first process ended. This is
**concurrent**: two processes alive at the same instant under one id, which no
resume can produce.

## The blind spot was total

The producer's `suspect` check is calibrated for lanes stretched to *now*. A
ghost born and closed inside the same day never reaches it.

Across every day swept, **every** unnamed single-interval lane came in **under**
the 4h cap — 41 on `08-05`, 19 on `08-04`, 22 on `07-31` — and not one exceeded
it. On `07-31` the check flagged exactly **1** lane out of those 22.

This is why the signature was worth computing at all, and also why a match was
only ever a lane *worth looking at* rather than a lane *known to be synthesized*.

## What is not a defect, despite looking like one

**An interval with an empty `status`.** It occurs only as the *leading* interval
— 882 of 969 lanes on `2026-08-05`, and **zero** occurrences after the first. It
is simply the gap between a session being discovered and its first transition.

Lanes whose only interval is statusless (30 that day) are processes that died
before transitioning at all. They are short: median 14 seconds.

The shape is common enough to invite a confident wrong diagnosis, which is
exactly what it got the first time.

## The case for declining to repair

The `2026-07-22` episode: a 9h54m arachne lane, pid 1236334, no session id, no
transition ever recorded. It looks like the same defect. It is not.

The pid has exactly one event in the whole retained history — a `session_start`.
Cross-referencing switchboard's own `docs/session-lifecycle-hazards.md`, the
daemon was SIGKILLed at `14:09:23` that day, 3m22s after this pid was discovered;
and this pid is absent from the rediscovery burst of five other live pids at
`14:09:26`. So: an already-fixed daemon defect of a different class, already
backstopped by the producer's `suspect` check — and emphatically *not* the
`session_end`-precedes-transition race that produced the `08-05` ghost. There is
no `session_end` here to race against.

Two things worth taking from it. "The data is what it is" is a successful
diagnosis, not a failed one. And the case that most looks like a known bug is
exactly where a repair would have been wrong.

## Resolution

- The producer defect behind the twelve is fixed at source: switchboard
  `e6b24ba`. The ancestor walk now stops at the helper itself, so a nested
  `claude -p` can no longer land its hook on an interactive parent.
- The write-order race behind the worked example is a genuine but rare shape —
  1 occurrence in seven days.
- The corpus this was measured on is gone. History retains roughly three weeks;
  every day discussed here predates that window.

What remains in this repo is the read-side defense, in
`internal/timeline/suspect.go`: plausibility caps calibrated against
switchboard's 31-day corpus (longest legitimate trailing interval observed
2h25m, shortest ghost 4h36m — 4h sits in the gap; paired subagent spans topped
out at 1h29m while reader-capped ones were all 10h+, so 2h separates those),
plus `clipToTrusted`, which refuses to credit a synthesized tail to any figure.
