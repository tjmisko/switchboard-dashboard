# switchboard-dashboard

A self-contained web activity monitor for the
[switchboard](https://github.com/tjmisko/switchboard) session timeline. It reads
the timeline through the stable `switchboard-ctl timeline --json` contract, which
keeps it decoupled from switchboard's on-disk history format, and renders a live
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
and the v2 fields) and history recording enabled in switchboard
(`~/.config/switchboard/history.json` set to `{"enabled":true,"detail":"full"}`).
Use `--ctl` to point at a specific binary and `--dir` for a non-default history
directory.

### Run against the bundled fixture

`testdata/` ships a synthetic v2 timeline and a stub `ctl`, so the full UI runs
with no switchboard install:

```sh
go build -o switchboard-dashboard .
./switchboard-dashboard --ctl ./testdata/stub-ctl.sh --plan ./testdata/plan-usage.json
# open http://localhost:8080/?day=2026-06-26
```

## Flags

| Flag     | Default                       | Description                                        |
| -------- | ----------------------------- | -------------------------------------------------- |
| `--port` | `8080`                        | HTTP port.                                         |
| `--ctl`  | `switchboard-ctl`             | The `switchboard-ctl` binary, resolved via `PATH`. |
| `--dir`  | `""`                          | History dir passed to ctl; empty uses ctl's own.   |
| `--plan` | `/tmp/claude-plan-usage.json` | Cached plan-usage file, read-only, for the gauge.  |

## HTTP API

- **`GET /api/timeline`** — proxies `switchboard-ctl timeline --json`, forwarding
  `day`, `since`, `until`, and `dir` as ctl flags. Returns ctl's JSON on success,
  or `502 {error, stderr}` when ctl exits non-zero.
- **`GET /api/plan`** — returns a normalized, read-only view of the cached
  plan-usage file for the cost gauge:
  `{available, mtime, age_seconds, stale, five_hour, seven_day, seven_day_opus}`.
  It never calls the OAuth endpoint. A missing file returns `200 {available:false}`
  and the UI falls back to its own recomputed cost.
- Static assets are served from `/`. The UI also reads `?day`, `?since`, and
  `?until` from its own URL, so a window is shareable.

## Data contract

The JSON shape and units are owned by switchboard (`docs/history-schema.md`):

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
switchboard install.
