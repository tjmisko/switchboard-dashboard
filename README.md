# switchboard-dashboard

A small, self-contained web dashboard for the **switchboard** activity timeline.

switchboard (the [producer](https://github.com/tjmisko/switchboard)) records what
your Claude/Codex sessions are doing — working, delegating, idle, waiting on a
permission prompt — into per-day history files. This dashboard is a **consumer**:
it shells out to the stable `switchboard-ctl timeline --json` contract and renders
the result as a swimlane timeline plus a summary panel. It never reads the history
files directly, so it stays decoupled from switchboard's on-disk format.

The whole UI (HTML/CSS/JS) is embedded into a single Go binary via `go:embed` —
no frameworks, no CDN, no external fetches. It works offline and loads instantly.

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
   subcommand. (Point at a specific binary with `--ctl /path/to/switchboard-ctl`.)
2. **History recording enabled** in switchboard:
   `~/.config/switchboard/history.json` containing `{"enabled":true}`. Without it,
   the history dir stays empty and the dashboard shows "No activity".

With history enabled, ctl's default history dir is
`$XDG_STATE_HOME/switchboard/history` (else `~/.local/state/switchboard/history`).
Pass `--dir` to point somewhere else (e.g. a fixture dir).

### Run against fixture data

```sh
# Build a current ctl from a switchboard checkout:
go build -C /path/to/switchboard -o ./.bin/switchboard-ctl \
    github.com/tjmisko/switchboard/cmd/switchboard-ctl

./switchboard-dashboard \
    --ctl ./.bin/switchboard-ctl \
    --dir ./testdata/history
# then open http://localhost:8080/?day=2026-06-20
```

## Flags

| Flag     | Default            | Description                                                            |
| -------- | ------------------ | --------------------------------------------------------------------- |
| `--port` | `8080`             | HTTP port to listen on.                                               |
| `--ctl`  | `switchboard-ctl`  | The `switchboard-ctl` binary; resolved via `PATH` if not a full path. |
| `--dir`  | `""`               | History dir passed through to ctl as `--dir`. Empty = ctl's default.  |

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

Static assets (`index.html`, `app.js`, `style.css`) are served from `/`.

The UI also reads `?day=`, `?since=`, `?until=` from its own URL so a window is
shareable/bookmarkable.

## The data contract

The JSON shape and its **units are owned by switchboard**, documented in its
`docs/history-schema.md` (and the timeline view it describes). The two units that
matter most when reading the numbers:

- **Durations are nanoseconds.** Everything under `summary.by_status` and the
  `summary.attention_*` figures is a nanosecond count — divide by `1e9` for
  seconds. The dashboard humanizes these (e.g. `2h 4m`, `300ms`).
- **Token fields are raw counts**, not durations. There is no grand-total token
  field; the dashboard sums `tok_in + tok_out + tok_cache_read + tok_cache_create`
  itself.

The three "attention" figures answer different questions:

- **A — union** (`attention_union`): wall-clock time with at least one session
  active (overlaps counted once).
- **B — per-session** (`attention_per_session`): the sum over sessions of active
  time (rewards parallelism).
- **C — fanout** (`attention_fanout`): active time weighted by `1 + subagents` —
  an approximation of total agent compute. This is the headline figure.

## Development

```sh
go test ./...   # handler + arg-builder tests (uses a stub ctl)
go vet ./...
```

Tests inject a stub `switchboard-ctl` (a shell script in a temp dir) via `--ctl`,
so they run without a real switchboard install.
