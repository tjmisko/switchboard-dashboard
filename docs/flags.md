# Flags: declaring timeline data wrong, and repairing the view

The dashboard renders whatever the timeline envelope says, and the envelope is
sometimes wrong. This is the mechanism for saying so: right-click a lane, flag
it, and a scoped agent works out why while a reversible overlay stops the bad
lane distorting the view.

The activity log the timeline is derived from is **append-only and owned by the
producer**. Nothing in this feature writes to it. A repair is an *overlay* — a
declarative statement stored beside the log and applied to the envelope on its
way to the browser — so `switchboard-ctl timeline --json` stays byte-identical
for anything else reading it, and every repair can be undone.

## The worked example

The lane that motivated this, from `2026-08-05.jsonl`:

```
10:29:37.438991459  transition working → idle   dur_prev_ms=16100   ← written first
10:29:37.437833786  session_end                                     ← stamped 1.16ms earlier
```

The session ran for **19 seconds**. Two writers race at process death — the
hook-driven closing transition and the pidfd death-watch's `session_end` — and
the death-watch stamped the earlier time while writing second. The reader orders
by timestamp, so it closes the lane on `session_end`, then meets a later
transition for the same `session_id` and opens a **second lane nothing ever
closes**. That lane stretched to the window bound and drew as three hours of
idle, unnamed, in its own one-session project group.

It is not caught by the producer's own `suspect` check: three hours sits under
the 4h `DefaultSuspectTrailingCap`, so the ghost is invisible until it has
already spent the day polluting the totals.

### How often, measured

Over the seven day-files 2026-07-30 → 08-05, the exact signature (a
`session_end` followed in timestamp order by a later `transition` for the same
session) occurs **16 times**: 1, 12, 0, 0, 0, 1, 2 per day. It is bursty rather
than steady — the twelve on 07-31 land in one day.

The blind spot is total. Across every day swept, **every** unnamed
single-interval lane came in **under** the 4h cap — 41 on 08-05, 19 on 08-04, 22
on 07-31 — and not one exceeded it. On 07-31 the producer's `suspect` check
flagged exactly **1** lane out of those 22. The check is calibrated for lanes
stretched to *now*; a ghost born and closed inside the same day never reaches it.

**What is NOT a defect, despite looking like one:** an interval with an empty
`status`. It occurs only as the *leading* interval — 882 of 969 lanes on
2026-08-05, and **zero** occurrences after the first — and is simply the gap
between a session being discovered and its first transition. Lanes whose only
interval is statusless (30 that day) are processes that died before transitioning
at all; they are short, median 14s. The investigator's prompt says so explicitly,
because the shape is common enough to invite a confident wrong diagnosis.

### The second worked example: declining to repair

The 2026-07-22 episode — a 9h54m arachne lane, `pid` 1236334, no session id, no
transition ever recorded — looks like the same defect and is not. Flagged, the
investigation returned **`correct-data` / `none` at medium confidence**, which
parks at `pending_review` and changes nothing.

It was right to. The pid has exactly one event in the whole retained history (a
`session_start`), and the investigation cross-referenced switchboard's own
`docs/session-lifecycle-hazards.md` — the daemon was SIGKILLed at `14:09:23`
that day, 3m22s after this pid was discovered — then observed that this pid is
absent from the rediscovery burst of five other live pids at `14:09:26`. Its
conclusion: an already-fixed daemon defect (the F1–F4 class), already backstopped
by the producer's `suspect` check, and *not* the `session_end`-precedes-transition
race that produced the 08-05 ghost. There is no `session_end` here to race
against.

Two things worth taking from it. A verdict of "the data is what it is" is a
successful investigation, not a failed one — and the case that most looks like a
known bug is exactly where a repair would have been wrong. And the citations in
that verdict were checked and are verbatim, which is what the
don't-cite-what-you-haven't-read instruction bought.

## Where things live

```
~/.local/state/switchboard/flags/          # --flags-dir; empty disables the feature
  <session-id>__<lane-start-epoch-ms>.json # one record per flagged LANE
  issues.jsonl                             # append-only investigation log
```

Under `state` rather than `share`, because losing it loses operator judgement
that cannot be regenerated. **Beside** switchboard's history rather than inside
it, because that directory belongs to the producer.

The key is session id **and** lane start. One session can own several lanes —
that is the whole shape of the ghost defect — and flagging the bad one must not
touch its sibling. The start is normalized to epoch milliseconds so two
spellings of one instant do not become two flags. `web/model.js`'s `laneFlagKey`
mirrors `internal/flags.Key` exactly, and a pinned test on both sides keeps them
from drifting.

## Record lifecycle

| status | means |
| --- | --- |
| `pending` | filed, investigation queued |
| `investigating` | an agent is looking at it |
| `applied` | verdict reached, overlay in force |
| `pending_review` | verdict reached, not confident enough to apply on its own |
| `failed` | the investigation produced no usable verdict |
| `reverted` | the operator withdrew an applied overlay |

A `failed` investigation leaves the flag on the lane: the operator's judgement
that something is wrong outlives the agent's failure to explain it.

## Repairs

| action | when | effect |
| --- | --- | --- |
| `suppress-lane` | the lane is pure synthesis | dropped from `lanes[]` |
| `clip-at` | the head is real, the tail is synthesized | `end` and the straddling interval truncated; the producer's `suspect` flag is cleared, since the tail it warned about is gone |
| `merge-into` | one session's work split across two lanes that **both** hold observed events | intervals, subagents, focus, labels and usage folded into the named sibling |
| `none` | the data is correct, or nothing conclusive | nothing |

The ghost above is `suppress-lane`, not `merge-into`. Merging a synthesized lane
into its real sibling would import three hours of fiction into a lane that was
fine. `merge-into` is for a genuine split — the pre-2026-07-21 restart artifact,
where a live session's id appeared to change and both halves hold real work.

## `summary` is deliberately not recomputed

A repair changes `lanes[]` and leaves `summary` alone. Re-deriving
`attention_union` and its siblings means reimplementing the producer's interval
algebra against a lane set it never saw, and a half-corrected total is worse than
an uncorrected one that says so.

The envelope instead grows `flags_applied`:

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

Show it *beside* a total rather than folding it in — the same treatment
`docs/history-schema.md` prescribes for `suspect_duration`.

**Byte-verbatim passthrough survives.** The single-provider path re-encodes only
when an overlay actually bites; a window with no applicable flag is proxied
untouched, fields the Go structs do not model included.

## The investigator

Filing a flag spawns `claude -p`. The safety property is not a sandbox
configuration:

> **The agent has no write tool.** Its entire effect on the world is the
> schema-validated verdict it returns. The Go process writes the overlay and the
> log line.

Fencing `Write`/`Edit` to one directory is a configuration, and configurations
are got wrong. An agent holding no write tool cannot damage anything whatever it
concludes, and the worst outcome available to a confused model is a wrong
overlay — which reverts.

The scope, from `internal/flagagent`:

- `--tools Read,Glob,Grep,Bash` — the whole built-in set it may use; none can modify anything.
- `--disallowedTools Edit,Write,NotebookEdit,WebFetch,WebSearch,Task` — redundant today, kept as the belt to that braces.
- `--allowedTools` — exactly the read commands needed (`rg`, `jq`, `switchboard-ctl timeline/history/diagnose`), so a headless session never blocks on a permission prompt it cannot answer.
- `--permission-mode dontAsk` — anything outside that list fails rather than hanging.
- `--add-dir <history>` — the evidence lives outside the working directory.
- `--max-budget-usd` — the spend bound. (Current Claude Code has **no** `--max-turns`.)
- `--no-session-persistence`, and `cmd.Dir` set to the flag store, so investigations never become sessions the dashboard then renders.

The verdict passes a closed enum twice: the JSON Schema tells the model what is
allowed, `flags.Verdict.Validate` decides what is acted on. Both are needed — the
schema is guidance, not a guarantee we control. `confidence: "high"` is what
permits auto-application; anything less parks as `pending_review`.

At most 2 investigations run at once (`flagagent.Limit`), each with a 5-minute
ceiling.

### The upstream draft is drafted, never filed

When the agent identifies a reproducible producer defect it writes a ready-to-file
issue body into `issues.jsonl`. A human decides whether it is worth a ticket.

This is not politeness. On the worked example the live agent produced an accurate
report with both viable fixes — and closed it by asserting that
`history-schema.md` "already documents this exact race by name", which it does
not; that vocabulary comes from the agent's own system prompt. The prompt now
forbids attributing claims to unread files, but **read the draft before filing
it.**

### Investigations show up on the timeline

Switchboard discovers `claude` processes from `/proc`, so an investigation is a
real session and gets its own lane, grouped under the flag directory's name.
`--no-session-persistence` keeps it out of `~/.claude/projects` but cannot hide
the process. Nothing on this side can fix that; it would take switchboard
learning to ignore a marked process.

## HTTP API

All three 404 when `--flags-dir` is empty. `POST` requires a same-origin request
(`Sec-Fetch-Site`, falling back to `Origin`); the server binds `127.0.0.1` by
default (`--bind`).

- **`POST /api/flags`** — `{session_id, lane_start, lane_end, provider, project, note}`.
  Files the flag and starts the investigation. Idempotent while one is in flight,
  so a double-click cannot buy a second agent; re-flagging a *settled* lane
  re-opens it, which is the operator saying "look again".
- **`GET /api/flags`** — `{flags: {<key>: record}}`. Always 200; an unconfigured
  store is an empty set, not an error.
- **`POST /api/flags/revert`** — `{session_id, lane_start}`. Withdraws the
  overlay. The record survives as `reverted` and the withdrawal is appended to
  the log: an overlay the operator rejected is evidence about the investigator.

## Flags

| flag | default | does |
| --- | --- | --- |
| `--flags-dir` | `~/.local/state/switchboard/flags` | flag store; empty disables flagging entirely |
| `--investigate` | `sonnet` | model for the investigation; empty records flags without investigating |
| `--investigate-budget` | `0.50` | dollar ceiling per investigation |
| `--bind` | `127.0.0.1` | listen interface |

## Testing

`go test ./...` never invokes a real `claude`; every agent test runs against a
stub `Runner`, the seam borrowed from `internal/sessiondigest`. The live
investigation is a test too, skipped unless opted into:

```sh
SWITCHBOARD_LIVE_AGENT=1 go test -run TestLiveInvestigation -timeout 10m ./internal/flagagent/
```

It runs against the real 2026-08-05 ghost, which is the hardest check available:
the right answer is known and is not the obvious one, so a model that
pattern-matches "long idle lane" without reading the events fails it.
