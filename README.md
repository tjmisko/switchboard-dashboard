# switchboard-dashboard

A self-contained web activity monitor for the
[Switchboard](https://github.com/tjmisko/switchboard) session timeline. It reads
the timeline through the stable `switchboard-ctl timeline --json` contract, which
keeps it decoupled from Switchboard's on-disk history format, and renders a live
swimlane view with attention, operator, and cost summaries.

The entire UI (HTML, CSS, JS) is embedded into one Go binary via `go:embed`. It
uses no frameworks and makes no external network calls beyond the local `ctl`
invocation, so it loads instantly and runs offline.

## What it shows

- **Swimlane timeline**, grouped by project. Each session is a compact bar keyed
  by stable identity (`session_id`, falling back to `pid`); sessions that never
  overlap in time share a row. Identity (`agent · pid · cost`) is drawn inside
  each bar.
- **Status at a glance**: `working`, `dormant` (waiting on a subagent), `idle`,
  `permission`, and `suspended`, with a cumulative-time legend that doubles as the
  color key.
- **Session-name spans** drawn along each bar from the `/name` history, so a
  mid-window rename reads as one bar with labeled segments. The pre-`/name`
  stretch falls back to the project name, rendered dim.
- **Subagent sub-bars** for delegated work — hover for detail, click to pin a
  popout.
- **Focus/attention overlay** highlighting spans where the session was focused and
  active; global idle periods are dimmed.
- **Operator lane** partitioning the running window into free time and time spent
  typing or recovering from a context switch.
- **Topline** headline: the effective time gained and the force multiplier from
  running agents in parallel.
- **Attention and cost cards**: delegation effectiveness with the
  union / per-session / delegated / attended / prompt breakdown, plus the window
  cost, a per-session breakdown, and a rolling 5h plan-usage gauge.
- **Hover any figure** for a descriptor showing its formula, result, and meaning.
- **Live by default**: polls `/api/timeline` every ~3s and repaints on change,
  with a freshness indicator.

## Quickstart

```sh
go build -o switchboard-dashboard .
./switchboard-dashboard            # serves http://localhost:8080
```

It requires a current `switchboard-ctl` on `PATH` (with the `timeline` subcommand
and the v2 fields) and history recording enabled in Switchboard
(`~/.config/switchboard/history.json` set to `{"enabled":true,"detail":"full"}`).
Use `--ctl` to point at a specific binary and `--dir` for a non-default history
directory.

### Run against the bundled fixture

`testdata/` ships a synthetic v2 timeline and a stub `ctl`, so the full UI runs
with no Switchboard install:

```sh
go build -o switchboard-dashboard .
./switchboard-dashboard --ctl ./testdata/stub-ctl.sh --plan ./testdata/plan-usage.json
# open http://localhost:8080/?day=2026-06-26
```

## Flags

| Flag          | Default                       | Description                                                              |
| ------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `--port`      | `8080`                        | HTTP port.                                                               |
| `--ctl`       | `switchboard-ctl`             | The `switchboard-ctl` binary for the default Claude provider.            |
| `--dir`       | `""`                          | History dir passed to ctl; empty uses ctl's own.                         |
| `--plan`      | `/tmp/claude-plan-usage.json` | Cached plan-usage file, read-only, for the gauge.                        |
| `--summaries` | `~/.local/share/switchboard/summaries` | Session-summary records from `session-digest`; empty disables.  |
| `--providers` | `""`                          | Providers config JSON; when set, merges the listed adapters (see below). |
| `--settings`  | `~/.config/switchboard/dashboard.json` | Operator-model settings (see below); a missing file means defaults. |

## Settings

The operator model turns your focus and activity streams into "time this cost
you" — the red half of the operator lane, the context-switch overhead, and the
wall-clock the topline's **net agent hours** nets off. The thresholds it uses
are judgement calls about how *you* work, not facts about the data, so they live
in a file you own rather than in the frontend's source:

```jsonc
// ~/.config/switchboard/dashboard.json — every key optional, every value in ms
{
  "away_after_ms": 300000,      // 5m
  "switch_recovery_ms": 90000,  // 90s
  "switch_flicker_ms": 500,     // 0.5s
  "min_engage_ms": 15000        // 15s
}
```

| Key                  | Default | What it decides                                                                                                                                                                                              |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `away_after_ms`      | `300000` (5m) | How long after your last keystroke or mouse move you still count as *at* a focused agent window. Reading a diff isn't idleness, so presence decays rather than blinking off — but a window left focused and untouched past this is you having **walked away**, and stops being charged as your time. Raise it if you read for long stretches; lower it if you leave sessions open when you go. |
| `switch_recovery_ms` | `90000` (90s)  | How long re-acquiring context costs you after a context switch. Recovery windows are **unioned**, so a burst of switches inside one window costs one recovery, not one apiece.                        |
| `switch_flicker_ms`  | `500` (0.5s)   | Minimum dwell for a focus arrival to count as a real switch at all. Below it, it's flicker (a notification, focus-follows-mouse) and is ignored by the count, the overlay, and the recovery charge alike. |
| `min_engage_ms`      | `15000` (15s)  | Minimum focus dwell to count as attending. Separate from the flicker floor: passing through a window is a switch, but it isn't time spent working in it.                                              |

Omitted keys keep their default and a missing file means "all defaults", so the
file need only carry what you're changing. A non-positive value falls back to
the default; a **malformed** file is a startup error rather than a silent
default — a setting that didn't take should be loud. The values are served at
`/api/settings` and fetched by the frontend before its first render; if that
fetch fails the frontend uses the same built-in defaults, so an unreachable
endpoint changes nothing.

## Data providers (adapters)

The dashboard renders a normalized **timeline envelope** and knows nothing about
where it comes from. A _provider_ is any binary that prints that envelope for a
window — `<exec…> timeline --json [--dir D] [--day D] [--since S] [--until U]`.
Claude (via `switchboard-ctl`) is just the default provider; any other source
that can emit the envelope plugs in the same way.

With no `--providers`, the dashboard runs the single Claude provider and proxies
its bytes verbatim (unchanged from before). Point `--providers` at a config to
**merge** several adapters into one namespaced view — lanes from every provider
in one timeline and one cross-provider "agents aloft" count, each lane tagged
with its provider (accent spine + legend chip). A provider that fails is recorded
in the envelope's `provider_errors` rather than blanking the dashboard; only an
all-providers-failed request is a `502`. See `examples/providers.json`.

**Writing your own provider:** [`docs/provider-contract.md`](docs/provider-contract.md)
is the full spec — the process contract, the envelope field by field with units,
a minimum viable envelope to copy, what each optional field buys you in the UI,
the suspect/ghost rules, and what the merge does to your output.

### Arachne provider (docker long-running sessions)

`arachne-switchboard-recorder` + `arachne-switchboard-ctl` add
[Arachne](https://github.com/tjmisko/Arachne)'s docker-based agent fleet as a
provider. Arachne containers run `--rm` with no labels, so Docker keeps no
history; the recorder is the durable memory it lacks.

```sh
go install ./cmd/arachne-switchboard-recorder ./cmd/arachne-switchboard-ctl

# 1. run the recorder (polls `docker ps`, tails container logs) — writes an
#    append-only history under ~/.arachne-switchboard/
arachne-switchboard-recorder -interval 5s      # or the systemd/ user unit

# 2. run the dashboard with both providers merged
switchboard-dashboard --providers examples/providers.json
```

The recorder polls `docker ps --filter name=arachne-agent`, extracts session
metadata (task/phase/model/workspace) via `docker inspect`, and parses each
container's stream-json log for Claude `Task` subagents and token usage. Because
containers vanish on exit, it records its own time series and, on restart,
reconciles against `docker ps` — closing sessions that ended while it was down at
their last-seen time. Each running container is counted as one agent aloft for
its lifetime (unattended auto mode), with subagent sub-bars layered on top.

A session is one container **run**, not one branch. Arachne names a container
after its worktree branch and the pump restarts that same name for each phase
task, so a slug recurs through the day; the container id is what tells the runs
apart, both between polls and across a recorder outage (it is persisted in
`state.json`). Runs after the first take a `#N` suffix on their session id
(`feat-f79`, `feat-f79#2`), which is what lets the dashboard — whose bars are
keyed on session id — draw them as the separate sessions they are.

## Session summaries (`session-digest`)

Subagents carry an authored identity from birth — the parent model writes a
`description` when it spawns them (the hover-modal text) — but interactive
sessions get only an auto-title. `session-digest` closes that gap: it condenses
each Claude Code transcript under `~/.claude/projects/` into a per-session
record, and can top it with an LLM-written name/description/tasks/summary so
sessions read like subagents.

```sh
go install ./cmd/session-digest

session-digest                  # backfill deterministic digests for every session
session-digest -condense        # + generate name/description/tasks/summary via `claude -p`
session-digest -print -session <id>   # inspect one record on stdout
```

Records land in `~/.local/share/switchboard/summaries/<project-slug>/<session-id>.json`
as `{digest, summary, summaryVersion, model, generatedAt}`, where the generated
`summary` object is:

```json
{
  "name": "fix-merged-view-lookup",
  "description": "Fixed the merged view's summary lookup and shipped the hover card",
  "tasks": ["Stripped the provider namespace from session ids", "Added the hover card"],
  "summary": "Framing prose — 1-2 sentences when tasks are present, 3-6 when they aren't."
}
```

`tasks` is the session's distinct work items in chronological order, at most six
(a busier session gets its six most substantial), and is omitted entirely for a
single continuous task — those sessions keep the full 3-6 sentence narrative.
`summaryVersion` is the output-schema version that produced the record
(currently `2`); a plain `-condense` run regenerates anything older, so schema
changes roll through the archive without `-force`. The digest half is deterministic
extraction — the session title records (`custom-title`/`ai-title`/`agent-name`),
the human prompts, authored Bash step descriptions, files edited, commit
subjects, tool counts, and the subagent roster. Subagent names and descriptions
are harvested verbatim from the session's `subagents/` metadata (falling back to
`Task`/`Agent` tool_use records for older sessions) and are never re-summarized.
The condenser sees only the digest, never the raw transcript, so the `claude -p`
call stays cheap and grounded.

Runs are incremental: digests rebuild when the transcript is newer than the
record, summaries generate when missing or written by an older schema version
(`-force` regenerates everything), transcripts
touched in the last `-min-idle` (default 10m) are presumed live and skipped, and
sessions with no extractable signal are never sent to the model. The
summarizer's own `claude -p` transcripts are excluded from scanning. To keep the
archive current automatically, wire `scripts/session-summary-hook` into a
`SessionEnd` hook in `~/.claude/settings.json` (instructions in the script).

The dashboard serves the archive at `/api/summaries` (see `--summaries`) and
surfaces it on the timeline: hovering a session's name band shows the generated
one-line description (and how many steps the card holds), and clicking pins a
card with the full name / description / task bullets / narrative — the same
interaction subagent sub-bars already have.

## HTTP API

- **`GET /api/timeline`** — with one provider, proxies its `timeline --json`,
  forwarding `day`, `since`, `until`, and `dir` as flags, and returns its JSON
  (or `502 {error, stderr}` on non-zero exit). With `--providers`, fetches every
  adapter in parallel and returns the merged envelope; per-provider failures land
  in `provider_errors` and only an all-failed request is a `502`.
- **`GET /api/summaries`** — returns `{sessions: {<session_id>: {name,
  description, tasks, summary, generated_at}}}` from the `--summaries` store,
  omitting digest-only records. `tasks` is the (optional, at most six) list of
  distinct work items the pinned card renders as bullets; it is absent for
  single-task sessions and for records generated before the field existed.
  Always `200`; a missing store yields an empty set.
- **`GET /api/memory`** — returns `{sessions: {<session_id>: {peak_agent_bytes,
  avg_agent_bytes, peak_tree_bytes, avg_tree_bytes, mem}}, pressure}` for the
  same window, from each provider's `memory --json`. Bytes throughout; `mem` is
  an optional `{ts, agent, tree}` series and `pressure` an optional machine-wide
  `{ts, avail_bytes, psi_avg10, psi_stall_us}` series. Always `200`; a provider
  that fails or does not implement the subcommand contributes nothing rather than
  erroring, so hovers simply go unenriched.
- **`GET /api/plan`** — returns a normalized, read-only view of the cached
  plan-usage file for the cost gauge:
  `{available, mtime, age_seconds, stale, five_hour, seven_day, seven_day_opus}`.
  It never calls the OAuth endpoint. A missing file returns `200 {available:false}`
  and the UI falls back to its own recomputed cost.
- **`GET /api/settings`** — returns the operator-model tunables
  (`away_after_ms`, `switch_recovery_ms`, `switch_flicker_ms`, `min_engage_ms`)
  loaded from `--settings`. Always `200`; an unconfigured server serves the
  documented defaults, which are also the frontend's fallbacks.
- Static assets are served from `/`. The UI also reads `?day`, `?since`, and
  `?until` from its own URL, so a window is shareable.

## Data contract

The JSON shape and units are owned by Switchboard (`docs/history-schema.md`);
[`docs/provider-contract.md`](docs/provider-contract.md) restates it as an
implementer's spec for anyone writing a provider:

- **Durations are nanoseconds**, **token fields are raw counts**, and **`cost_usd`
  is a float in dollars** recomputed by the producer from tokens × per-model price.
- The envelope is `{window, lanes, summary, totals}` with optional top-level
  `activity` and `plan_window`. Every v2 field is additive and optional; older
  day-files omit them and the UI degrades gracefully.

The summary exposes three attention figures: **union** (wall-clock with at least
one session active), **per-session** (the sum of per-session active time), and
**fanout** (active time weighted by subagents, approximating total agent compute).

### Memory

Memory rides a **separate surface** (`/api/memory`, from each provider's
`memory --json`), deliberately not the timeline envelope. Two reasons, and both
are load-bearing rather than stylistic:

- A live sample series changes the timeline response bytes on every poll, which
  would defeat the unchanged→no-repaint check. Memory instead follows the
  session-summaries pattern — its own endpoint, its own slow cadence, read lazily
  when a tooltip opens, so it costs no repaints at all.
- On the producer side, memory samples are kept out of lane routing entirely so
  they cannot disturb the suspect-lane post-check. A sample fires every tick
  whether or not the session is doing anything, so counting it as evidence of
  life would mask exactly the lost-session-death case that check exists to catch.

Per session: `peak_*`/`avg_*` for the agent process alone and for its whole
process tree, in bytes (`Pss + SwapPss`). `tree − agent` is what spawned work
cost — subagents have no PIDs, so the tree is the only unit that captures them.
Averages are time-weighted. Container providers (arachne) report a tree figure
only, with no agent split, since a container total has no meaningful inner
boundary.

### Suspect lanes

A session that no `session_end` ever closed is drawn out to the window bound, so
its tail is *synthesized rather than observed* — the 2026-07-22 episode where
three phantom subagent sessions each read as 4½ hours of work. The producer
flags that shape instead of hiding it:

- On a lane: `suspect`, `suspect_reason`, `suspect_since`. **`start`/`end`/
  `intervals` are never truncated** — `suspect_since` is the last instant with
  evidence behind it, and everything from there to `end` is inference. The UI
  hatches that stretch in amber with a `?` badge; the reason is shown verbatim on
  hover, because "stretched to now" (a live ghost) and "stretched to window
  bound" (which also catches a legitimate session running across midnight) are
  not the same claim.
- On a subagent span: `suspect`, `suspect_reason` — a span whose stop event never
  arrived. Drawn as a phantom, never credited as compute.
- On the summary: `suspect_lanes` and `suspect_duration`, where the duration is
  exactly how much synthesized time every *other* figure in the summary already
  excludes.

The consequence for consumers: any "active" figure re-derived client-side by
summing interval durations must clip each suspect lane at `suspect_since`, or it
will disagree with the summary. `web/model.js` exposes `clipSpanMs` for that: the
single clip every re-derivation in the UI goes through. `laneActiveMs` is the
ready-made helper for the common case, summing one lane's own intervals.
Providers this repo compiles itself (arachne) run the same check with the caps in
`internal/timeline/suspect.go`; a provider that omits the fields entirely is
merged exactly as before, never silently clipped.

### The live bound is quantized

Anything still running when a provider renders is closed at "now", and every
provider truncates that instant onto a shared 30s grid
(`timeline.LiveBoundQuantum`) first. The dashboard polls `/api/timeline` every 3s
and repaints only when the payload changes, so a bound at full precision stamps a
fresh timestamp on every live lane and defeats that guard on every single poll.

The grid is shared deliberately: providers quantizing onto *different* grids
would move the merged bytes on the union of their grids, and the coarser one
would buy nothing. A new adapter that closes open work at its own clock should
truncate the same way — `switchboard-ctl` does (`nowQuantum`), and arachne does
in `Compile`. Truncated, never rounded: a lane must not extend past the present,
and must not end before its own start either, so a session that began inside the
current bucket is closed at its start rather than behind it.

## Development

```sh
go test ./...   # handler, arg builder, /api/plan, and the name-span contract
node --test     # render-model unit tests (web/model.js)
go vet ./...
```

The render model — identity keying, name spans, and row packing — lives in
`web/model.js` as DOM-free pure functions covered by `web/model.test.js`. The Go
tests inject a stub `ctl` and temporary plan files, so they need no real
Switchboard install.

The provider layer lives under `internal/`: `internal/timeline` (the envelope
types + `Merge`), `internal/provider` (the `Provider` interface, subprocess
adapter, and config), and `internal/arachne` (docker enumeration, stream-json log
parsing, the append-only history recorder, and the compiler). Each has its own
unit tests, including a recorder test that fakes docker and a fixed clock to
exercise lifecycle and restart reconciliation.
