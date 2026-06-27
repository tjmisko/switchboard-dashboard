# Handoff — switchboard-dashboard UI pass (feat/operator-bar)

You are picking up an in-progress frontend iteration on the **switchboard-dashboard**.
This document is everything you need to finish the **three remaining tasks (T14, T15, T16)**.

---

## 1. Project / environment

- **What it is:** a Go web server that renders an "activity monitor" timeline of
  Claude Code agent sessions. It shells out to `switchboard-ctl timeline --json`
  (the stable v2 data contract) and serves a vanilla-JS + SVG frontend. No JS deps.
- **Where:** you are in the worktree `~/Projects/switchboard-dashboard/.worktrees/feat/operator-bar`
  on branch **`feat/operator-bar`**. Do all work here.
- **Files that matter:**
  - `web/app.js` — all rendering logic (SVG timeline, cards, operator lane). ~1050 lines.
  - `web/model.js` — pure, DOM-free helpers (shared with the node test suite). Exposed as globals.
  - `web/model.test.js` — node test suite (`node web/model.test.js`, uses node:test/assert).
  - `web/style.css` — all styling (CSS custom props / theme at the top).
  - `web/index.html` — static shell.
  - `handler.go` — `//go:embed web/index.html web/model.js web/app.js web/style.css`. **Assets are embedded**, so a binary rebuild is required for any web/ change to show up.
  - `main.go`, `handler_test.go` — server + tests.

## 2. Build / deploy / verify loop (do this after every change)

```
cd ~/Projects/switchboard-dashboard/.worktrees/feat/operator-bar
node --check web/app.js          # JS syntax
node web/model.test.js           # model tests (keep green)
go build ./... && go test ./...  # embed compiles + handler tests
go install . && systemctl --user restart switchboard-dashboard   # deploy to :8080
```
- The live dashboard is the systemd `--user` service on **http://localhost:8080**
  (`go install` writes `~/go/bin/switchboard-dashboard`; the unit runs that binary).
- **Gotcha:** `curl http://localhost:8080/index.html` 301-redirects to `/`; verify
  served HTML with `curl -s http://localhost:8080/` (not `/index.html`).
- To inspect real data: `curl -s 'http://localhost:8080/api/timeline?day=YYYY-MM-DD'`.

## 3. Data contract (v2 timeline JSON) — essentials

- Durations in `summary.*` / `attention_*` are **nanoseconds**; token fields are raw counts; `cost_usd` is float dollars. Timestamps are RFC3339 (`Date.parse` OK).
- `data.lanes[]` — one per session. Each lane: `start`,`end` (RFC3339), `pid`,
  `agent`, `project`, `project_full?`, `session_id?`, `cost_usd?`, `tok_*`,
  `intervals[]` ({status,start,end}; status ∈ working/delegating/dormant/idle/permission/suspended),
  `focus[]` ({start,end} — spans you were focused on this session),
  `names[]` (slug span history), `labels[]`, `subagents[]`.
- `data.activity[]` ({state:'active'|'idle', start, end}) — global keyboard activity (optional).
- `data.summary` — `attention_fanout` (agent-hours, parallelism counted),
  `attention_union` (wall-clock with ≥1 active), `attention_per_session`,
  `delegated_active`, `attended_active`, `prompt_active`, `delegation_effectiveness`.
- **Cost is NOT computed here** — `cost_usd` comes precomputed from `switchboard-ctl`
  (a separate repo; only the binary is on disk at `~/go/bin/switchboard-ctl`).

## 4. What's already done (committed `8061b5f` + UNCOMMITTED working tree)

All of the following are in the working tree; only the first batch is committed.

- Topline = **additional time** headline (`+Xh`, green) with subtitle
  "as if a `<24h+extra>` day", where extra = `attention_fanout − attention_union`.
  Second figure = **force multiplier** = `fanout ÷ union`, subtitle "over `<union>` active".
  → `renderTopline()` in app.js.
- **Operator lane** (top row): green = "free" (free agent), dusty-red = occupied;
  free/occupied derived in `computeOperatorTime()`.
- Removed the always-on red ctx-switch verticals; re-added them behind a
  **"show context switches" checkbox** (off by default) — `el.optCtxSwitches`,
  drawn from `op.switchTimes` at the bottom of `renderTimeline()`. CSS `.ctx-switch`,
  `.chart-options`/`.chart-opt`.
- **Gutter** currently shows per-session identity (`agent · short-session-id` + cost
  beneath); pid hidden (hover tooltip only). Rows tightened, bars taller, fonts +1px.
- **15s engagement threshold** `OP_MIN_ENGAGE_MS`: focus spans < 15s are ignored in
  `computeOperatorTime()` (not editing, not a switch). ← interacts with T16.
- **Sub-minute session filter** `renderableLanes()` (MIN_SESSION_MS = 60000): drops
  sessions whose lifespan < 60s from timeline, operator calc, and cost list. Lanes
  with unparseable bounds are kept.
- model.js: tested `spanInefficiency(lane, segStartMs, segEndMs)` (% idle/waiting)
  shown in the name-span hover tooltip.
- Attention card shows `context switches` + `operator time lost to AI` (see T16).

**Verification state:** model tests 12/12, `node --check`, `go build`, `go test` all green.

---

## 5. REMAINING TASKS

### T16 — Fix the context-switch count (smallest; do first)

**Problem (confirmed against live data 2026-06-26):** there are **434 raw
focus-arrivals** (≈433 switches) but the card shows ~60. Cause: `computeOperatorTime()`
applies the **15s `OP_MIN_ENGAGE_MS` filter to the switch-detection set** (it filters
`focusPairs`/`focusStarts`), and `switches = focusStarts.slice(1)`. Median focus span
is 1.2s, so 371/432 spans are dropped. The 15s filter is correct for *time accounting*
(free/occupied/lost) but should NOT gate the *count*.

**Fix:** compute the displayed switch count from the **unfiltered** focus arrivals
(across renderable lanes), independent of `OP_MIN_ENGAGE_MS`. Keep the 15s filter only
for the occupied/lost/free time math. In `computeOperatorTime()`:
- Keep `focusPairs`/`focusStarts` (≥15s) for `engaged`/`ctxRecovery`/`typing`/time.
- Add a second, unfiltered list of focus starts; return `switches` = its length − 1
  and `switchTimes` from it (so the toggle overlay also shows all switches — confirm
  with the user whether the *overlay* should show all or only ≥15s).
- **Decision to confirm with user:** (a) count every focus arrival, or only arrivals
  where the *session changes* vs the immediately-prior focus (true context switch)?
  (b) include focus on sub-minute sessions? (negligible: only ~2 today). Recommend:
  count = (focus arrivals in renderable lanes) − 1, no 15s filter; revisit "different
  session" refinement if the number still looks off.
- Files: `web/app.js` `computeOperatorTime()` (~line 316). Add a model.js helper +
  test if you want it covered.

### T15 — Make the attention & delegation card prettier, on-theme

`renderAttentionCard(summary, op)` (app.js ~line 866) builds `el.cardAttention`. It is
currently a flat `.kv` list (delegation-effectiveness headline, then union/per-session,
then delegated/attended/prompt, then the two new rows context-switches / time-lost).
The user finds the box plain.

- Restyle using the existing theme tokens in `style.css` (`--bg-elev`, `--border-soft`,
  `--c-working` green, `--c-idle`, `--c-permission`, `--accent`, `--mono`). Group the
  rows into clear sections with subtle section headers (there's already `.kv-head`,
  `.kv-sep`, `.card-label` patterns to reuse), give the operator-overhead metrics
  (context switches / time lost to AI) visual weight/accent so they read as their own
  block, and keep numbers in mono. Match the look of the cost card next to it.
- Keep it responsive (the card sits in a `repeat(auto-fit, minmax(280px,1fr))` grid).
- Files: `web/app.js` `renderAttentionCard()`; `web/style.css` `.card`/`.kv*` section.

### T14 — Identity-in-span + pack serializable sessions onto one row (largest)

Two coupled changes to the timeline layout:

**(a) Move per-session identity into the span.** Today the left gutter (GEO.GUTTER =
232px) holds one session's identity per row. Once rows hold multiple sessions (below),
that can't work. Move `agent · pid · cost` out of the gutter and render it **inside
each session's span** (in/near the name-span band), "spread across" the span width
(e.g. agent·pid at the span's left, cost at the right, or distributed; hide when the
span is too narrow, keep it in the hover tooltip). pid should be visible here (the user
explicitly wants the pid in the span now). The project name stays in the group header.
Decide what, if anything, the gutter shows now (likely nothing, or a thin row marker).

**(b) Pack time-serializable sessions onto the same row.** Within each project group,
multiple sessions that DON'T overlap in time should share one row (greedy interval
partitioning — assign each session, in start order, to the first row whose last
session ends before this one starts; otherwise open a new row). The number of rows for
a group = its max simultaneous overlap. Combined with the already-done sub-minute
filter, this is what the user described: **Switchboard's 4 sessions → 2 rows** (one is
sub-minute and already dropped; the most-recent session starts after the first ends, so
it packs onto row 1).

Implementation notes / current code to refactor:
- Layout loop: `renderTimeline()` ~lines 511–525 currently does one `lane._top` per
  lane. Replace with: for each group, pack its `g.lanes` into rows; give each ROW a
  `_top`/`_height`; record which sessions sit on each row and at what x-range.
- `laneHeight(lane)` (~465) and `drawLane(lane, …)` (~652) are per-session today. You'll
  want a `drawRow(row, …)` that draws every session on the row at its own x-range:
  status bars (`intervals`), name-span band (`nameSegments`), subagents, AND the
  in-span identity. Subagent sub-rows (`GEO.SUB_ROW_H`) should still only be reserved
  when a session on that row actually delegated.
- `GEO` block (~line 449+) holds the vertical metrics; `drawOperatorLane` (~619) is the
  top operator row and is unaffected.
- **Confirm with user:** pack only within a project group (recommended; matches the
  example) vs globally; and whether to require a small gap between "serializable" runs
  or treat any non-overlap as packable (recommend: any non-overlap, i.e. `nextStart >= prevEnd`).
- This is the biggest change — keep `node web/model.test.js` green and consider adding a
  pure `packLanes(lanes)` helper to model.js with tests (interval-partition is very
  testable).

---

## 6. Suggested order & commit

1. T16 (small, unblocks the count the user is watching), 2. T15 (self-contained), 3. T14
(largest). The working tree is **uncommitted since `8061b5f`** — the user has been
deploying live and will likely want to commit; ask before committing/pushing. Conventional
commits (`feat:`/`fix:`), end messages with the Co-Authored-By trailer the user uses.

Open questions to raise with the user are flagged inline above (T14 packing scope, T16
count semantics, T16 overlay set).
