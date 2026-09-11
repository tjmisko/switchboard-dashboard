# Repairing the view without touching the log (shelved design)

**Status: shelved. Not implemented, and nothing in the tree depends on it.**

This is a design that was built on `feat/session-flags` and never merged. The
branch is gone; the reason the code went with it is that it was inseparable from
an investigator agent whose job no longer exists — see `ghost-lanes.md` for why.
The repair mechanism underneath it is sound and independent of that agent, so it
is written down here rather than lost.

Read this if manual data repair ever becomes a real need. Nothing here is a
commitment to build it.

## The problem it solves

A producer occasionally emits a lane that is wrong — synthesized, split in two,
or attributed to the wrong project. Two obvious responses are both bad:

- **Edit the day-file.** Now the log is no longer a record of what was observed,
  and re-running the producer silently reverts the fix.
- **Live with it.** The lane distorts every total on the day, permanently.

The third way: leave the producer's data exactly as written, and apply the
operator's corrections as the last step before the envelope reaches the browser.
Re-running the producer yields the original lanes, unchanged. The repair lives
beside the data, never inside it.

## Where a repair would live

```
~/.local/state/switchboard/flags/          # --flags-dir; empty disables the feature
  <session-id>__<lane-start-epoch-ms>.json # one record per flagged LANE
```

Under `state` rather than `share`, because losing it loses operator judgement
that cannot be regenerated. **Beside** switchboard's history rather than inside
it, because that directory belongs to the producer.

**The key is session id _and_ lane start.** One session can own several lanes —
that is the entire shape of the ghost defect — so flagging the bad one must not
touch its sibling. The start is normalized to epoch milliseconds, so two
spellings of one instant cannot become two records. Any client-side mirror of
this key needs a pinned test on both sides; they drift otherwise.

## The repairs

| action | when it applies | effect |
| --- | --- | --- |
| `suppress-lane` | the lane is pure synthesis | dropped from `lanes[]` |
| `clip-at` | the head is real, the tail is synthesized | `end` and the straddling interval truncated |
| `merge-into` | one session's work split across two lanes that **both** hold observed events | intervals, subagents, focus, labels and usage folded into the named sibling |
| `none` | the data is correct, or nothing was conclusive | nothing |

**Choosing between them is the whole design.** The `2026-08-05` ghost is
`suppress-lane`, not `merge-into`: merging a synthesized lane into its real
sibling would import three hours of fiction into a lane that was fine.
`merge-into` is for a genuine split, where both halves hold real observed events.
Getting this backwards produces a confidently wrong timeline, which is worse than
the defect.

A `clip-at` also clears the lane's `Suspect`, `SuspectReason` and `SuspectSince`.
The tail the producer was warning about is the tail just removed, and leaving the
lane marked suspect would keep the UI hatching a stretch that no longer exists.

## The failure semantics, which are the valuable part

Every one of these is a case where doing nothing is correct and doing something
is a silent data loss. They are easy to get wrong on a first implementation.

- **An unparseable or out-of-range clip point leaves the lane whole.** A cut at
  or before the lane start would erase the lane; a cut at or past its end would
  do nothing. Neither is a repair, so both are refused loudly rather than
  performed quietly.
- **A merge whose target is not in this window keeps the orphan.** The target may
  be outside the requested day, or may itself have been suppressed. The operator
  asked to *relocate* this data, not to lose it, so an unresolvable merge leaves
  the lane where it is.
- **An unparseable timestamp never widens a lane.** The comparison used when
  merging bounds treats "cannot parse" as "not earlier", so a malformed bound
  can only fail to extend a lane, never extend it wrongly.
- **Records outlive the day they were filed on.** Overlays are indexed by lane
  key and simply never match a window they do not belong to — asking for last
  Tuesday must not resurrect last Tuesday's repairs.
- **Merges resolve after the main pass.** A lane may fold into a sibling that
  appears later in `lanes[]` and has not been visited yet, so they are collected
  during the walk and applied afterwards.

## `summary` and `totals` are deliberately not recomputed

A repair changes `lanes[]` and leaves the aggregates alone.

Re-deriving `attention_union` and its siblings means reimplementing the
producer's interval algebra against a lane set it never saw. A half-corrected
total is worse than an uncorrected one that says so.

Instead the envelope grows an audit list, so every repair is visible to whatever
renders it:

```jsonc
"flags_applied": [{
  "key": "296eb0f0-…__1785950977438",
  "session_id": "296eb0f0-…",
  "lane_start": "2026-08-05T10:29:37.438991459-07:00",
  "action": "suppress-lane",
  "verdict": "ghost-lane",
  "removed_ns": 13903263610422        // lane wall-clock this repair took out of lanes[]
}]
```

Show it *beside* a total rather than folding it in — the same treatment the
history schema prescribes for `suspect_duration`.

**Byte-verbatim passthrough must survive.** The single-provider path re-encodes
only when an overlay actually bites; a window with no applicable repair is
proxied untouched, including fields the Go structs do not model. In practice this
means the apply step returns "nothing matched" as a distinct answer from "matched
and changed nothing", and the caller keeps its fast path on the former.

## What this would cost on today's `main`

`internal/timeline/types.go` already carries `Suspect`, `SuspectReason` and
`SuspectSince` through lanes, spans and totals — the producer-side plausibility
check landed with `internal/timeline/suspect.go`. There is **no** `FlagsApplied`
anywhere, so the audit list above is entirely new surface.

The two mechanisms are complementary rather than competing, and the distinction
is worth stating: `suspect` is the *producer* saying "I synthesized this tail,
do not trust it", applied automatically and always. A view-time repair is the
*operator* saying "this specific lane is wrong", applied only where they said so.
One is calibrated and general; the other is manual and particular.

## What is deliberately not recorded here

The branch drove these repairs from a headless agent that investigated a flagged
lane and returned a verdict. That part is obsolete and is not preserved: the
defect it investigated is fixed at source and the corpus it read has aged out.

The one idea worth carrying forward from it lives in the code rather than here —
an agent given no tools at all, whose every effect on the world passes through
one validated struct. See `claudeArgv` and `Summary.Validate` in
`internal/sessiondigest/condense.go`, and the README section on the summarizer.
