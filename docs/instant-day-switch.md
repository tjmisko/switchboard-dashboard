# Instant day switching

## Measurements (live server, 2026-08-06, headless Chrome over CDP)

| stage | cost |
|---|---|
| `fetch /api/timeline` | **1381 / 1532 / 1549 ms** (265 KB day) · **1963 ms** (35 KB day) |
| `JSON.parse` | 0.6 ms |
| `render()` — sessions, 171 lanes | 22 ms median (60 ms cold) |
| `render()` — line | 6 ms |
| `render()` — projects | 1.6 ms |
| forced layout after render | 3.3 ms |
| SVG nodes on the heavy day | 1050 |

The fetch cost is **flat in payload size** — the 35 KB day is *slower* than the
265 KB day. It is fixed provider-subprocess cost (spawn + history scan), not
bytes on the wire and not parsing.

**Rendering is ~1.5% of a day switch.** The renderer does not need optimizing.
The latency is a blocking `await` with no UI in front of it.

## What is actually wrong

### 1. The day is not application state

The current day lives in a hidden `<input>` and is read by `buildQuery()` at
fetch time. There is no "requested day" vs "rendered day" distinction, so there
is nothing to paint optimistically *against*. `stepDay()` → `reloadNow()` →
`await fetch` → `render()`: between keypress and paint, the only thing that
changes on screen is the text of the date label.

### 2. There is no request lifecycle

`loadTimeline()` has no `AbortController`, no sequence number, and no in-flight
tracking. Consequences, in order of severity:

- **Stale-day flash.** The 3 s poll and a day switch race. A poll issued for day
  A that lands after the switch to B calls `render(A)` — the chart shows A while
  the label says B, until the next poll heals it up to 3 s later.
- **Rapid stepping multiplies subprocesses.** Holding `Ctrl+→` across five days
  fires five overlapping 1.5 s subprocess spawns. Each keypress makes the
  machine *slower* at answering the one request you care about.
- **The `text === lastTimelineText` guard is global, not per-day.** It compares
  against whatever day was fetched last, so it is only accidentally correct.

### 3. Closed days are polled forever

`setInterval(loadTimeline, 3000)` is unconditional. `isLiveWindow()` exists but
gates only chart padding (app.js:1796, 1814), never polling. Sitting on a past
day re-spawns a 1.5 s subprocess every 3 s to re-fetch a window that **cannot
change** — a ~50% duty cycle of pure waste, competing with the next real fetch.

### 4. The entry animation is bound to the wrong event

`armChartEnter()` is called only from `setView()` (app.js:774). Switching *view*
gets the 380 ms plotter-head sweep; switching *day* — a much bigger content
change — gets no animation at all. The mechanism is already built and already
correct; it is simply wired to the wrong trigger.

## The redesign

Not a rendering redesign. Split what is currently one blocking function into
three layers with independent timelines.

### Layer 1 — synchronous shell (0 ms, on the keypress)

Promote the window to real state:

```js
let view = { day, status: "settled" | "pending" | "error", data, seq };
```

`stepDay`/`commitDay` transition it **synchronously** and paint the frame
before yielding: day label, gutter, plot box at the correct height, ghost lane
rows, axis frame. No spinner — the container is the real chart, minus lanes.

The shell must not commit to a horizontal scale it may have to take back (see
**Open decision**).

### Layer 2 — cancellable async (the fetch)

- `AbortController` per day change; abort the previous timeline request.
- Monotonic `seq`; the response handler drops anything whose `(day, seq)` is not
  current. Kills the stale-day flash.
- **Debounce the fetch ~120 ms, never the shell.** The shell moves on every
  keypress at 0 ms; held arrows coalesce to one subprocess.
- Gate polling on `isLiveWindow()`. A closed day polls zero times.

### Layer 3 — arrival (the reveal)

When data for the current day lands, reuse `armChartEnter()` — rebind it from
"view changed" to "content identity changed" so a day switch earns the same
sweep. Ghost rows cross-fade into real lanes; the 22 ms render is invisible
inside a 380 ms reveal.

### Layer 0 — the server (the real fix)

Frontend work hides the 1.5 s; it does not remove it. Two changes remove it:

- **Cache closed days.** A past day's timeline is immutable. An in-memory LRU
  keyed by `day` makes every revisit ~0 ms and makes the shell → data gap
  disappear entirely for backward navigation. Highest leverage change here.
- **Prefetch neighbors.** Once a day settles, speculatively fetch `day−1` (and
  `day+1` when it is not today) into that cache. With caching, arrow-stepping
  through history becomes instant after the first hop.
- Optional: stale-while-revalidate for *today* — serve the cached envelope
  instantly, refresh behind it.

## Decided: the axis keeps its per-day autoscale, and the shell defers it

`summary.from`/`to` are the day's **first and last activity** (e.g.
`07:23:40 → 08:24:56`), not calendar bounds, so the horizontal scale is not
knowable until data lands.

The shell therefore paints everything that *is* knowable at 0 ms — the plot
frame, the gutter, ghost lane rows — and draws **no axis ticks and no labels**
until real bounds arrive. It never states a scale it would have to take back.
The rule for the whole skeleton follows from this: *show structure, never
assert a value.*

The alternative (pinning the axis to the calendar day) would have made the
shell exactly right at 0 ms and made days comparable, at the cost of screen
space on empty night hours. Not taken.

## Results

Measured the same way as the table above — headless Chrome over CDP against the
real provider, 2 merged providers, 171-lane day.

| | before | after |
|---|---|---|
| keypress → something on screen | ~1500 ms (nothing moved until data landed) | **4.8 ms** |
| requests issued during that paint | — | **0** (fetch is debounced behind the shell) |
| 5 rapid `stepDay` calls | 5 overlapping subprocess spawns | **1 request** (+1 prefetch) |
| revisiting a day already seen | full ~1500 ms round trip | **no request at all** (client cache) |
| closed day, repeat request | 1799 ms | **0.4 ms** (`X-Cache: hit`) |
| idling 8 s on a closed day | ~3 requests, ~4.5 s of subprocess | **0 requests**, timer disarmed |
| idling 8 s on today | 3 requests | 3 requests (live poll preserved) |
| chart vs. date label during a switch | could disagree for up to 3 s | always agree (seq guard) |

### Incidental fix

`.provider-key { display: flex }` outranked the `[hidden]` attribute's UA
`display: none`, so `renderProviderKey`'s `hidden = true` never actually hid
anything. The legend stayed up in the single-provider view it is meant to be
absent from — and, once a pending state existed, sat there showing the outgoing
day's lane counts under the incoming day's date. Fixed with an explicit
`.provider-key[hidden] { display: none }`.
