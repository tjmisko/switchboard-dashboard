# switchboard-dashboard

A small, self-contained web **activity monitor** for the **switchboard**
timeline.

switchboard (the [producer](https://github.com/tjmisko/switchboard)) records what
your Claude/Codex sessions are doing — working, delegating to subagents, idle,
waiting on a permission prompt — into per-day history files. This dashboard is a
**consumer**: it shells out to the stable `switchboard-ctl timeline --json`
contract and renders the result as a dominant, always-live swimlane timeline plus
a compact attention/cost strip. It never reads the history files directly, so it
stays decoupled from switchboard's on-disk format.

The whole UI (HTML/CSS/JS) is embedded into a single Go binary via `go:embed` —
no frameworks, no CDN, no external fetches. It works offline and loads instantly.

## What it shows

- **Live by default.** No refresh button, no auto-refresh toggle — it polls
  `/api/timeline` every ~3s and repaints only when the data changes, with a small
  "updated _Xs_ ago" indicator and a status dot (green = fresh, amber = aging,
  red = error/stale).
- **Dominant swimlanes** at the top of the fold: one full-width, tall lane per
  session.
  - `working` is solid green; **`delegating` is faded green** (the agent handed
    work to subagents).
  - Each lane draws its **subagent spans** as thin violet sub-bars (packed into
    rows by overlap). Hover for a tooltip; **click to pin a popout** with the
    subagent's `agent_type`, `description`, and duration.
  - **Session-name labels** (multilabel over time): the lane label is the latest
    `labels[]` entry; if the name changed mid-window a violet ribbon marks the
    segments and the full history shows on hover. Falls back to
    `project · agent · pid` when no label was recorded.
  - **Focus/attention overlay**: spans where you were focused on that session
    **and** active (not idle) are outlined/hatched in blue, so attended-vs-
    delegated work is visible at a glance. Global idle periods are dimmed.
- **Time-by-status is the legend.** The per-status totals strip above the
  swimlanes doubles as the color key (all statuses shown, including zeros).
- **Consolidated attention card**: the headline **fanout (C)** "agent compute"
  figure next to the **delegation-effectiveness %**, with union (A), per-session
  (B), and the delegated / attended / prompt breakdown beneath.
- **Cost card**: the window total (`totals.cost_usd`, recomputed from
  tokens × model price), a per-session breakdown, and a rolling **5h plan-window
  gauge** that pairs our own `$` (`plan_window.cost_usd`) with the official
  utilization **%** read read-only from the OAuth cache (see `/api/plan`).

## Quickstart

```sh
# 1. Build
go build -o switchboard-dashboard .

# 2. Run against switchboard's real history (ctl's default dir once history is on)
./switchboard-dashboard

# 3. Open the URL it logs (default http://localhost:8080)
```

`switchboard-dashboard` requires two things from switchboard:

1. **A current `switchboard-ctl` on your `PATH`** that has the `timeline`
   subcommand and emits the v2 fields (labels, subagents, focus, cost,
   `plan_window`). Point at a specific binary with `--ctl /path/to/switchboard-ctl`.
2. **History recording enabled** in switchboard:
   `~/.config/switchboard/history.json` containing `{"enabled":true}` (and
   `"detail":"full"` for names/descriptions). Without it the history dir stays
   empty and the dashboard shows "No activity".

With history enabled, ctl's default history dir is
`$XDG_STATE_HOME/switchboard/history` (else `~/.local/state/switchboard/history`).
Pass `--dir` to point somewhere else (e.g. a fixture dir).

### Run against the committed fixture (no switchboard install needed)

`testdata/` ships a synthetic full-detail v2 fixture and a stub `switchboard-ctl`
that prints it, so you can drive the whole UI offline:

```sh
go build -o switchboard-dashboard .
./switchboard-dashboard \
    --ctl  ./testdata/stub-ctl.sh \
    --plan ./testdata/plan-usage.json
# then open http://localhost:8080/?day=2026-06-26
```

- `testdata/timeline/2026-06-26-full.json` — a `timeline --json` document
  exercising every v2 field (multi-label lanes, subagent spans, focus spans,
  per-lane + total cost, `plan_window`, global `activity`, and the delegation
  summary metrics).
- `testdata/stub-ctl.sh` — a fake ctl that ignores its flags and prints that
  fixture.
- `testdata/plan-usage.json` — a sample of the read-only OAuth plan cache for the
  5h/weekly gauge.

## Flags

| Flag     | Default                        | Description                                                                 |
| -------- | ------------------------------ | --------------------------------------------------------------------------- |
| `--port` | `8080`                         | HTTP port to listen on.                                                      |
| `--ctl`  | `switchboard-ctl`              | The `switchboard-ctl` binary; resolved via `PATH` if not a full path.       |
| `--dir`  | `""`                           | History dir passed through to ctl as `--dir`. Empty = ctl's default.        |
| `--plan` | `/tmp/claude-plan-usage.json`  | Cached OAuth plan-usage file, read **read-only** for the utilization gauge. |

## HTTP API

### `GET /api/timeline`

Proxies `switchboard-ctl timeline --json`. Query params are forwarded to ctl:

| Param   | Maps to     | Notes                                            |
| ------- | ----------- | ------------------------------------------------ |
| `day`   | `--day`     | `YYYY-MM-DD` (default: today, per ctl).          |
| `since` | `--since`   | `YYYY-MM-DD`; with `until`, a range.             |
| `until` | `--until`   | `YYYY-MM-DD`. A range takes precedence over day. |
| `dir`   | `--dir`     | Overrides the server's `--dir` for this request. |

- **200** `application/json` — ctl's stdout, passed through verbatim.
- **502** `application/json` — `{"error": "...", "stderr": "..."}` when ctl exits
  non-zero (e.g. a malformed date), with ctl's stderr included.

### `GET /api/plan`

Reads the cached OAuth plan-usage file (`--plan`, default
`/tmp/claude-plan-usage.json`) **read-only** and returns a normalized view for
the cost gauge. It **never** calls the OAuth endpoint or refreshes the token —
Claude Code writes that file while a session runs; the dashboard only reads it.

- Always **200** `application/json`.
- Shape: `{ "available": bool, "mtime": RFC3339, "age_seconds": int,
  "stale": bool, "five_hour": {utilization, resets_at},
  "seven_day": {...}, "seven_day_opus": {...} }`.
- An **absent** file is the expected "no recent session" state and returns
  `{"available": false}` (not an error), so the UI degrades to showing only our
  own recomputed `$`.
- `stale`/`age_seconds` come from the file mtime: the file only refreshes while a
  Claude Code session is live, so the UI grays/age-stamps a `%` that hasn't
  updated recently. Only utilization **%** is exposed by Anthropic for a solo
  subscription (the `*_dollars` fields are always null), which is why the `$` half
  of the gauge is switchboard's own recompute.

Static assets (`index.html`, `app.js`, `style.css`) are served from `/`. The UI
also reads `?day=`, `?since=`, `?until=` from its own URL so a window is
shareable/bookmarkable.

## The data contract

The JSON shape and its **units are owned by switchboard**, documented in its
`docs/history-schema.md`. Units:

- **Durations are nanoseconds** (`÷1e9` for seconds) — everything under
  `summary.by_status`, the `summary.attention_*` figures, and the
  `summary.{prompt,attended,delegated}_active` delegation durations. The dashboard
  humanizes these (e.g. `2h 4m`, `300ms`).
- **Token fields are raw counts** (`tok_in`, `tok_out`, `tok_cache_read`,
  `tok_cache_create`); there is no grand total, so the dashboard sums them.
- **`cost_usd` is a float in dollars**, recomputed by the producer from
  `tokens × per-model price` (no native API exposes dollar cost for a solo
  subscription).

The v2 envelope is `{window, lanes, summary, totals}` plus optional top-level
`activity` and `plan_window`. Every v2 field is **additive and optional** — older
day-files (or recording at `detail:"minimal"`) simply omit them and the UI
degrades gracefully. New/changed fields the dashboard consumes:

| Field                                   | Meaning                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| `lanes[].intervals[].status`            | adds `delegating` (faded green: agent handed work to subagents)|
| `lanes[].labels[]` `{label,start,end}`  | session name over time (multilabel)                            |
| `lanes[].subagents[]`                   | `{agent_type, tool_use_id, description, start, end}` sub-bars  |
| `lanes[].focus[]` `{start,end}`         | spans where this session was the focused window                |
| `lanes[].cost_usd`, `lanes[].tok_*`     | per-session cost + token breakdown                             |
| `totals.cost_usd`                       | window-total cost                                              |
| `summary.prompt_active`                 | time you were driving the prompt (ns)                          |
| `summary.attended_active`               | agent active while you supervised (ns)                         |
| `summary.delegated_active`              | agent active while you were away — true delegation (ns)        |
| `summary.delegation_effectiveness`      | `delegated / (delegated + attended)`, float 0..1               |
| `plan_window` `{hours,from,to,cost_usd,tok_*}` | rolling 5h window total (the `$` half of the gauge)     |
| `activity[]` `{state,start,end}`        | global `idle`/`active` stream (for the focus∩active overlay)   |

The three "attention" figures answer different questions:

- **A — union** (`attention_union`): wall-clock time with at least one session
  active (overlaps counted once).
- **B — per-session** (`attention_per_session`): the sum over sessions of active
  time (rewards parallelism).
- **C — fanout** (`attention_fanout`): active time weighted by `1 + subagents` —
  an approximation of total agent compute. This is the headline figure.

> **Contract notes / interpretations.** `activity[]` (the global idle/active
> stream) is consumed as an **optional top-level** array; when absent the
> focus/attention overlay degrades to focus-only (no idle dimming, no
> focus∩active intersection). The producer derives global active/idle intervals
> for the delegation summary, so exposing them at top level keeps the per-lane
> overlay honest — confirm the field name during integration. `delegating` is
> rendered faded green and `working` solid; when both `delegated`/`attended`
> durations are present the dashboard recomputes effectiveness client-side if
> `delegation_effectiveness` was omitted.

## Development

```sh
go test ./...   # handler + arg-builder + /api/plan tests (uses a stub ctl & temp files)
go vet ./...
go build -o switchboard-dashboard .
```

Tests inject a stub `switchboard-ctl` (a shell script in a temp dir) via `--ctl`
and temp plan files via `Server.PlanPath`, so they run without a real switchboard
install or the live OAuth cache.
