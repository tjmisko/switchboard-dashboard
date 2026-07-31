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

## Session summaries (`session-digest`)

Subagents carry an authored identity from birth — the parent model writes a
`description` when it spawns them (the hover-modal text) — but interactive
sessions get only an auto-title. `session-digest` closes that gap: it condenses
each Claude Code transcript under `~/.claude/projects/` into a per-session
record, and can top it with an LLM-written name/description/summary so sessions
read like subagents.

```sh
go install ./cmd/session-digest

session-digest                  # backfill deterministic digests for every session
session-digest -condense        # + generate name/description/summary via `claude -p`
session-digest -print -session <id>   # inspect one record on stdout
```

Records land in `~/.local/share/switchboard/summaries/<project-slug>/<session-id>.json`
as `{digest, summary, model, generatedAt}`. The digest half is deterministic
extraction — the session title records (`custom-title`/`ai-title`/`agent-name`),
the human prompts, authored Bash step descriptions, files edited, commit
subjects, tool counts, and the subagent roster. Subagent names and descriptions
are harvested verbatim from the session's `subagents/` metadata (falling back to
`Task`/`Agent` tool_use records for older sessions) and are never re-summarized.
The condenser sees only the digest, never the raw transcript, so the `claude -p`
call stays cheap and grounded.

Runs are incremental: digests rebuild when the transcript is newer than the
record, summaries generate only when missing (`-force` overrides), transcripts
touched in the last `-min-idle` (default 10m) are presumed live and skipped, and
sessions with no extractable signal are never sent to the model. The
summarizer's own `claude -p` transcripts are excluded from scanning. To keep the
archive current automatically, wire `scripts/session-summary-hook` into a
`SessionEnd` hook in `~/.claude/settings.json` (instructions in the script).

The dashboard serves the archive at `/api/summaries` (see `--summaries`) and
surfaces it on the timeline: hovering a session's name band shows the generated
one-line description, and clicking pins a card with the full name / description
/ narrative — the same interaction subagent sub-bars already have.

## HTTP API

- **`GET /api/timeline`** — with one provider, proxies its `timeline --json`,
  forwarding `day`, `since`, `until`, and `dir` as flags, and returns its JSON
  (or `502 {error, stderr}` on non-zero exit). With `--providers`, fetches every
  adapter in parallel and returns the merged envelope; per-provider failures land
  in `provider_errors` and only an all-failed request is a `502`.
- **`GET /api/summaries`** — returns `{sessions: {<session_id>: {name,
  description, summary, generated_at}}}` from the `--summaries` store, omitting
  digest-only records. Always `200`; a missing store yields an empty set.
- **`GET /api/plan`** — returns a normalized, read-only view of the cached
  plan-usage file for the cost gauge:
  `{available, mtime, age_seconds, stale, five_hour, seven_day, seven_day_opus}`.
  It never calls the OAuth endpoint. A missing file returns `200 {available:false}`
  and the UI falls back to its own recomputed cost.
- Static assets are served from `/`. The UI also reads `?day`, `?since`, and
  `?until` from its own URL, so a window is shareable.

## Data contract

The JSON shape and units are owned by Switchboard (`docs/history-schema.md`):

- **Durations are nanoseconds**, **token fields are raw counts**, and **`cost_usd`
  is a float in dollars** recomputed by the producer from tokens × per-model price.
- The envelope is `{window, lanes, summary, totals}` with optional top-level
  `activity` and `plan_window`. Every v2 field is additive and optional; older
  day-files omit them and the UI degrades gracefully.

The summary exposes three attention figures: **union** (wall-clock with at least
one session active), **per-session** (the sum of per-session active time), and
**fanout** (active time weighted by subagents, approximating total agent compute).

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
