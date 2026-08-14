# Writing a data provider

A **provider** is any program that can report what agents did during a time
window. The dashboard renders a single normalized shape — the **timeline
envelope** — and knows nothing else about where the data came from. Claude (via
`switchboard-ctl`) and Arachne (via `arachne-switchboard-ctl`) are both just
providers; a source of agent logs plugs in the same way, in any language.

There are two things to get right:

1. **The process contract** — how the dashboard invokes you (§1).
2. **The envelope** — the JSON you print (§3 onward).

The Go types in [`internal/timeline/types.go`](../internal/timeline/types.go)
are the machine-readable copy of §3; the fixture
[`testdata/timeline/2026-06-26-full.json`](../testdata/timeline/2026-06-26-full.json)
is a complete worked example that exercises every field.

---

## 1. The process contract

Your provider is an executable that prints an envelope on stdout:

```
<your-exec…> [--dir D] [--day YYYY-MM-DD] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
```

- The **base argv** is whatever you put in `exec` in the providers config —
  binary, subcommand, and any fixed flags of your own (e.g.
  `["switchboard-ctl","timeline","--json"]`).
- The dashboard **appends** the window flags, and only these:

  | Flag      | When appended                                                    | Meaning                                     |
  | --------- | ---------------------------------------------------------------- | ------------------------------------------- |
  | `--dir`   | when the provider's config `dir` is non-empty (single-provider mode also forwards a `?dir=` query param) | where your history lives          |
  | `--day`   | when the request carries `?day=`                                  | one local calendar day                      |
  | `--since` | when the request carries `?since=`                                | window start, local calendar day            |
  | `--until` | when the request carries `?until=`                                | window end, local calendar day, **inclusive** |

  Absent flags mean "apply your own default" — typically today.
  A flag you don't understand should still be accepted rather than fatal; the
  Arachne adapter, for instance, accepts `--plan-window` and ignores it.
- **Exit 0 + JSON on stdout** is success. Anything else is a failure, and your
  **stderr is what the operator sees**, so make it a real diagnostic.
- The dashboard polls roughly every 3 seconds and runs all providers in
  parallel, each under the HTTP request's context. Be fast and side-effect free:
  a provider is a *reader*. If observing your source requires long-running
  collection (Arachne's containers vanish on exit), do that in a separate
  recorder daemon and let the provider compile its durable log — see
  [`cmd/arachne-switchboard-recorder`](../cmd/arachne-switchboard-recorder).

### Failure handling

| Situation                              | Result                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------- |
| One of several providers fails          | Its `{provider, error}` lands in the envelope's `provider_errors`; every other provider still renders. |
| Every provider fails                    | `502 {error, stderr}`.                                                  |
| Single-provider mode, provider fails    | `502 {error, stderr}`.                                                  |

A provider that has nothing to report should exit 0 with an **empty envelope**
(`lanes: []`), not an error. "No sessions today" is data, not a fault.

## 2. Registering it

Add it to a providers config and start the dashboard with `--providers`:

```json
{
  "providers": [
    {
      "id": "claude",
      "label": "Claude",
      "exec": ["switchboard-ctl", "timeline", "--json", "--plan-window"],
      "capabilities": { "plan": true }
    },
    {
      "id": "mysource",
      "label": "My Source",
      "exec": ["my-timeline-adapter", "timeline", "--json"],
      "dir": "/home/you/.local/share/mysource",
      "capabilities": { "plan": false }
    }
  ]
}
```

- `id` — required, unique. It namespaces your session ids in the merged view and
  keys your accent color. Keep it short and stable.
- `label` — display name; defaults to `id`.
- `exec` — required, non-empty. `exec[0]` is resolved via `PATH`.
- `dir` — optional default `--dir` value.
- `capabilities.plan` — declare `true` only if you emit `plan_window` (the
  rolling plan-usage gauge is an Anthropic-account concept).

With `--providers` unset, the dashboard runs one implicit `claude` provider from
`--ctl`/`--dir` and proxies its bytes verbatim.

## 3. The envelope

```jsonc
{
  "window": "2026-06-26",       // display label for the window
  "lanes": [ … ],               // one entry per session — the only field the UI truly needs
  "summary": { … },             // window-level aggregates
  "totals": { … },              // window-level token/cost sums
  "activity": [ … ],            // OPTIONAL operator active/idle stream
  "plan_window": { … },         // OPTIONAL rolling plan-usage total
  "provider_errors": [ … ]      // set by the dashboard; providers omit it
}
```

**Units are load-bearing and identical across providers:**

| Kind         | Representation                                                    |
| ------------ | ----------------------------------------------------------------- |
| Timestamps   | RFC3339 strings, fractional seconds allowed (`2026-06-26T13:00:00Z`). UTC is the safe choice. |
| Durations    | **integer nanoseconds** (`by_status.*`, `attention_*`, `*_active`, `suspect_duration`). |
| Tokens       | raw counts, integers.                                             |
| Cost         | `cost_usd`, a float in dollars, recomputed by you from tokens × per-model price. |

Every field is **additive and optional** except where noted: omit what your
source can't observe and the UI degrades gracefully rather than breaking. A
span whose `end` is not strictly after its `start` is silently dropped by every
consumer, so never emit zero-length or inverted spans.

### Lane — one session's bar

```jsonc
{
  "session_id": "ce13c0f2-…",       // stable identity; bars are keyed on this
  "pid": 4821,                      // identity fallback when session_id is absent
  "agent": "claude",                // agent kind, drawn inside the bar
  "provider": "mysource",           // optional; the dashboard fills in your id
  "project": "switchboard",         // groups lanes into swimlanes — REQUIRED in practice
  "project_full": "switchboard",    // optional pretty name; used as the lead label
  "start": "2026-06-26T13:00:00Z",  // REQUIRED
  "end":   "2026-06-26T14:40:00Z",  // REQUIRED
  "intervals": [ … ],               // REQUIRED — status segments, see below
  "labels":  [ {"label","start","end"} ],  // optional raw name history (lead-label fallback)
  "name":    "dashboard-name-spans",       // optional current session name
  "names":   [ {"label","start","end"} ],  // optional name-span history, in order
  "subagents": [ … ],               // optional delegated sub-bars
  "focus":   [ {"start","end"} ],   // optional: when this session had operator focus
  "cost_usd": 3.41,
  "tok_in": 41000, "tok_out": 18000,
  "tok_cache_read": 5100000, "tok_cache_create": 96000,
  "suspect": false, "suspect_reason": "", "suspect_since": ""   // see §5
}
```

Identity rules that matter:

- **Bars are keyed by `session_id`, falling back to `pid:<pid>`.** Identity must
  be stable across polls, or a bar splits mid-window. It must *not* change when
  the session is renamed — that is what `names[]` is for.
- **Emit bare ids.** The merged view rewrites `session_id` to
  `"<provider>:<id>"` itself; pre-namespacing double-prefixes it and breaks the
  join to `/api/summaries`.
- If one logical unit of work restarts under the same name, those are **separate
  sessions** and need distinct ids (Arachne suffixes reruns `feat-f79`,
  `feat-f79#2`), or the dashboard draws them as one impossible bar.
- `project` is what groups lanes into swimlanes; non-overlapping lanes in a
  project share a row. A provider with no project concept should emit a constant.

### Interval — one status segment

```jsonc
{"status": "working", "start": "…", "end": "…", "subagents": 2}
```

Intervals partition the lane's lifetime. `subagents` is the count running at the
segment's start (shown on hover; optional).

| Status       | Meaning                                | Counts as active work?         |
| ------------ | -------------------------------------- | ------------------------------ |
| `working`    | the agent was producing work            | **yes**                        |
| `dormant`    | parent waiting on a subagent            | no — the subagent span carries it |
| `idle`       | alive but doing nothing                 | no                             |
| `permission` | blocked on operator approval            | no                             |
| `suspended`  | paused/backgrounded                     | no                             |
| `delegating` | legacy spelling of `dormant`            | yes, for back-compat only — **don't emit it** |
| `""` / other | unknown                                 | no                             |

Use these names. An unrecognized status still draws and still gets a legend row
(from your `by_status`), but in a generic color with no explanatory gloss, and it
is credited as active by nothing.

If your source has no status concept at all — a container is either up or it
isn't — one `working` interval spanning the lifetime is a legitimate model. That
is exactly what the Arachne adapter does.

### Subagent — a delegated sub-bar

```jsonc
{
  "agent_type": "Explore",
  "tool_use_id": "toolu_a1",          // stable id for the span
  "description": "map the JSON contract",  // shown in the hover/pinned card
  "start": "…", "end": "…",
  "suspect": false, "suspect_reason": ""
}
```

Subagent spans are what make the fanout figure and the "agents aloft" chart mean
anything: a parent that is `dormant` contributes nothing, and its subagent's span
contributes instead, so parallel work is counted once and only once.

That is also why `end` carries real weight here: a span that closes early does
not just shorten one bar, it deletes delegated work from the topline while the
parent's `dormant` interval credits nothing in its place. See §5.1 for the
acknowledgement trap that produces exactly that.

### Activity — the operator stream (optional, top level)

```jsonc
[{"state": "active", "start": "…", "end": "…"},
 {"state": "idle",   "start": "…", "end": "…"}]
```

Whether *the human* was at the keyboard, independent of any one session. Combined
with per-lane `focus[]` it drives the operator lane (typing vs context-switch
recovery vs free time). Omit both if you can't observe them; the operator lane
degrades to treating any focus as typing, and with neither it stays empty.

### Summary — window aggregates

```jsonc
{
  "from": "2026-06-26T13:00:00Z",
  "to":   "2026-06-26T14:40:00Z",
  "sessions": 4,
  "by_status": {"working": 9600000000000, "idle": 2340000000000, … },  // ns per status
  "attention_union": 6000000000000,        // ns of wall-clock with ≥1 session active
  "attention_per_session": 14460000000000, // ns, sum of per-session active time
  "attention_fanout": 27420000000000,      // ns, active time weighted by subagents
  "prompt_active": 3000000000000,             // optional attention decomposition
  "attended_active": 3360000000000,           //   (omit all four if you don't
  "delegated_active": 11100000000000,         //    model operator attention)
  "delegation_effectiveness": 0.7676,         //   delegated / (delegated + attended)
  "suspect_lanes": 0, "suspect_duration": 0   // see §5
}
```

The three attention figures are three different questions and must not be
conflated:

- **union** — wall-clock during which at least one session was aloft. Overlap
  counted once.
- **per-session** — the sum of each session's own active time. Two sessions
  working the same hour give two hours.
- **fanout** — active time weighted by concurrent subagents; approximates total
  agent compute. This is what the topline divides by union to get the force
  multiplier.

### Totals and plan_window

```jsonc
"totals": {"tok_in": …, "tok_out": …, "tok_cache_read": …,
           "tok_cache_create": …, "subagents": 8, "cost_usd": 8.19}
```

`plan_window` is the rolling plan-usage total (`hours`, `from`, `to`, `cost_usd`,
`tok_*`). It is an Anthropic-account concept; providers without one omit it, and
in a merged view the first provider that supplies one wins.

## 4. The minimum viable provider

This renders — a bar, a swimlane, a status legend, and a topline:

```json
{
  "window": "2026-06-26",
  "lanes": [
    {
      "session_id": "run-1",
      "agent": "myagent",
      "project": "myproject",
      "start": "2026-06-26T13:00:00Z",
      "end": "2026-06-26T13:45:00Z",
      "intervals": [
        {"status": "working", "start": "2026-06-26T13:00:00Z", "end": "2026-06-26T13:45:00Z"}
      ]
    }
  ],
  "summary": {
    "from": "2026-06-26T13:00:00Z",
    "to": "2026-06-26T13:45:00Z",
    "sessions": 1,
    "by_status": {"working": 2700000000000},
    "attention_union": 2700000000000,
    "attention_per_session": 2700000000000,
    "attention_fanout": 2700000000000
  },
  "totals": {}
}
```

Everything beyond that is opt-in, and each field buys one specific thing:

| Add                                   | Get                                                      |
| ------------------------------------- | -------------------------------------------------------- |
| `tok_*`, `cost_usd` (lane + totals)   | cost card, per-session cost breakdown, in-bar `$` figure |
| `subagents[]`                         | sub-bars, hover/pin cards, meaningful `attention_fanout`, agents-aloft chart |
| `name` + `names[]`                    | name-span labels along the bar instead of a bare project name |
| `focus[]` (+ top-level `activity[]`)  | focus overlay and the operator lane                       |
| `prompt/attended/delegated_active`    | the delegation-effectiveness card                         |
| `plan_window` + `capabilities.plan`   | the rolling 5h plan gauge                                 |
| `suspect*`                            | honest rendering of unclosed sessions (§5)                |

## 5. Ghosts: the suspect contract

A session that no end event ever closed gets drawn out to the window bound, so
its tail is **synthesized rather than observed** — the failure mode that once
showed three phantom subagents as 4½ hours of work each. The contract is to
*flag* that shape, never to hide or truncate it:

- On a lane: `suspect`, `suspect_reason`, `suspect_since`. **Do not truncate
  `start`/`end`/`intervals`** — `suspect_since` is the last instant with evidence
  behind it, and everything from there to `end` is inference. The UI hatches that
  stretch in amber with a `?` badge and shows your reason verbatim, so write a
  reason that distinguishes the cases ("stretched to now" — a live ghost — is a
  different claim from "stretched to window bound", which also catches a
  legitimate session running across midnight).
- On a subagent span: `suspect`, `suspect_reason` for a span whose stop event
  never arrived. It is drawn as a phantom and never credited as compute.
- On the summary: `suspect_lanes` and `suspect_duration`, where the duration is
  exactly how much synthesized time **every other figure in your summary already
  excludes**.

**The aggregate invariant:** your `summary` must agree with what a consumer gets
by summing your `lanes`, after clipping each suspect lane at its `suspect_since`.
Credit no time past `suspect_since`, and credit no suspect subagent span at all.
Get this wrong and the topline disagrees with the bars underneath it.

Providers compiled in this repo use the calibrated caps in
[`internal/timeline/suspect.go`](../internal/timeline/suspect.go) — a trailing
silence ≥ 4h on an unclosed lane, an unpaired subagent span ≥ 2h. Omitting the
fields entirely is fine and means "I don't run this check"; such a lane is
merged exactly as before and never silently clipped.

### 5.1 The opposite ghost: a span that ends too early

Everything above is about spans that run too **long**. The more dangerous
failure runs the other way, because nothing downstream can catch it.

**A `subagent_stop` must mean the delegated work ended.** Do not derive one
from a spawn acknowledgement. Claude Code answers every `Agent` dispatch with
a `tool_result` ~2s after launch that only says the agent has *started* — the
outcome arrives much later as a `<task-notification>` entry, never as a second
`tool_result`. A provider that pairs the dispatch against that ack emits a
perfectly well-formed two-second span for an agent that then works for an hour.

That shape is invisible to §5: the span is closed, `suspect` is false, and the
duration is short rather than implausibly long. There is no consumer-side check
that separates it from a genuinely fast agent, which is why it is stated here
as a producer obligation rather than handled downstream. **The dashboard adds
no guard against short spans, deliberately** — a threshold would silently
suppress real fast agents while hiding the producer defect it was papering
over.

The diagnostic signature, if you suspect a stream has this: compare flat
subagent spans against workflow-agent spans, which are paired from a run
journal and never see an ack. In switchboard's own 31-day history, workflow
agents produced **no** span under 30s, while flat agents produced 94 (66 of
them under 5 seconds) out of 419.

Known corrupted window: switchboard's history log carries these truncated
spans for every `Agent` fanout up to 2026-08-14, and its `delegating` intervals
are correspondingly missing. Both are repaired in place by
`switchboard/scripts/repair-launch-ack-spans`; the producer fix is in
`switchboard/docs/async-agent-launch-ack.md`.

### 5.2 Known limitation: a span is in-flight time, not work time

A subagent span runs spawn-to-finish, and an agent parked on a permission
prompt is still in flight. So a span can include time the agent did nothing but
wait for a human, and every consumer of these spans — the fanout figure, the
agents-aloft chart, the force-multiplier headline — currently credits that wait
as delegated work.

Measured across every subagent transcript on the development machine
(2026-08-14): **17.6 h of 127.5 h of total span time (13.8%) was spent parked on
an unanswered `tool_use`.** Normally the distortion is small, but it is
unbounded and concentrates badly — a single overnight wait produced two spans
that were 92% and 97% dead time, and those two alone are 15.4 h of that 17.6 h.

This is not repaired, and deliberately not papered over with a heuristic. The
information needed is per-span blocked intervals, which no producer currently
emits: the history log records a permission `transition` at session level, not
per delegated writer, so the overlap cannot be reconstructed after the fact for
a session with more than one agent. Closing it properly means a producer-side
field (blocked intervals on the subagent span) rather than a consumer-side
guess, and until then the honest reading of the fanout figure is "agent time in
flight", not "agent time working".

## 6. What the merge does to your envelope

In multi-provider mode the dashboard parses every envelope and merges them.
Know what survives:

- **Lanes** are concatenated, tagged with `provider` (yours if set, else your
  config `id`), and their `session_id` rewritten to `"<provider>:<id>"`.
- **Additive fields sum**: `sessions`, `by_status`, `attention_per_session`,
  `attention_fanout`, `prompt/attended/delegated_active`, `suspect_lanes`,
  `suspect_duration`, and all of `totals`.
- **`attention_union` is recomputed** across providers — it is the one
  non-additive figure — as the wall-clock during which any lane anywhere was
  aloft, applying the suspect clip described above.
- **`delegation_effectiveness` is recomputed** from the summed parts.
- **`from`/`to`** become the min/max across providers; `activity[]` is unioned;
  `plan_window` comes from the first provider that has one.
- **Fields the Go structs don't model are dropped in the merged path.** The
  single-provider path proxies bytes verbatim, so an extra field survives there
  but not in a merge — if a new field must survive, add it to
  `internal/timeline/types.go`.

Consequence for you: emit correct per-provider aggregates and don't try to
account for anyone else's. Emit bare session ids. Don't set `provider` unless
your source genuinely multiplexes several.

## 7. Checklist

- [ ] Exits 0 and prints one JSON envelope on stdout; diagnostics on stderr.
- [ ] Accepts `--dir`, `--day`, `--since`, `--until`; ignores flags it doesn't use.
- [ ] Empty window → `lanes: []`, exit 0 (not an error).
- [ ] Every timestamp RFC3339; every duration integer nanoseconds; `cost_usd` float dollars.
- [ ] `session_id` stable across polls, bare (unnamespaced), distinct per run.
- [ ] Every span has `end` strictly after `start`.
- [ ] Statuses drawn from the table in §3.
- [ ] `summary` reconciles with the lanes, honoring the suspect clip.
- [ ] Fast enough to run every ~3s, and read-only.

### Testing without a dashboard rebuild

Any script that prints an envelope is a provider, which makes a fixture-backed
stub the fastest way to iterate on the shape — see
[`testdata/stub-ctl.sh`](../testdata/stub-ctl.sh):

```sh
# single provider, straight from a fixture
./switchboard-dashboard --ctl ./testdata/stub-ctl.sh --plan ./testdata/plan-usage.json

# your adapter merged alongside Claude
./switchboard-dashboard --providers examples/providers.json

# check the wire shape directly
curl -s 'localhost:8080/api/timeline?day=2026-06-26' | jq '{window, lanes: (.lanes|length), summary, provider_errors}'
```

If your provider is written in Go and lives in this repo, reuse
`internal/timeline` for the envelope types and the time helpers (`ParseNanos`,
`SpanNanos`, `UnionNanos`, `NanoToRFC`); `internal/arachne/compile.go` is a
complete reference implementation, aggregates and suspect check included.
