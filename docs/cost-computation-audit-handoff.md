# Claude and Codex cost computation: audit and implementation handoff

Status: implemented on review branches; not deployed
Audit date: 2026-08-25  
Repositories:

- `switchboard`: provider observation, history events, pricing, aggregation, and `switchboard-ctl timeline`
- `switchboard-dashboard`: timeline proxying, multi-provider merge, and browser presentation

## Goal

For every Claude or Codex session, Switchboard must identify the execution provider and billing route, preserve the billable usage dimensions, refresh an authoritative current price catalog, and expose a cost estimate whose meaning and confidence are explicit.

The system must never turn missing provider, model, price, or usage information into a believable `$0.00`.

## Executive conclusion

The current cost figure is not reliable:

- Codex usage is not sampled into history and therefore has no computed cost.
- Claude usage can be counted more than once because streamed assistant fragments with the same message ID are summed independently.
- Claude child-agent transcripts are omitted, while root-transcript fragments are overcounted. The net error can be high or low and cannot be corrected with a constant multiplier.
- Claude's cache-creation total combines 5-minute and 1-hour writes even though those buckets have different prices.
- Claude prices are a static family table. Exact models, fast mode, regional inference, provider-specific routes, and metered tools are not represented.
- Unknown models contribute zero cost. The dashboard then formats that zero as `$0.00`, masking incomplete coverage.
- `agent` currently means the client implementation (`claude` or `codex`), not necessarily the company that executes or bills the request.
- Codex can be funded through an API account, a ChatGPT subscription, or credits. A token-times-API-price number is useful for comparison but is not always a billed-dollar estimate.

The replacement must carry raw usage and provenance first, then derive multiple explicitly named cost concepts.

## Current data flow

```text
Claude transcript ──> fanout.go usage_sample ──┐
                                                │
Codex app-server/rollout ──> no usage_sample ───┤
                                                v
                                      history timeline.go
                                      static pricing.go
                                                │
                                                v
                              switchboard-ctl timeline --json
                                                │
                                                v
                               dashboard handler.go proxy
                               dashboard merge.go sums floats
                                                │
                                                v
                                     web/app.js renders USD
```

The dashboard does not independently price sessions. The authoritative implementation belongs in `switchboard`; the dashboard must preserve and explain the richer result.

## Audit evidence

### Static pricing and silent zeroes

`switchboard/internal/history/pricing.go` contains four hard-coded Claude family prices and chooses a price by substring (`opus`, `sonnet`, `haiku`, or `fable`). Unknown models return `0`.

The same function feeds lane, total, and plan-window costs in `internal/history/timeline.go`. `internal/history/timeline_test.go` currently asserts that an unknown model contributes nothing. That assertion codifies the failure mode and must be replaced with coverage/status assertions.

### Claude collection

`switchboard/cmd/switchboard/fanout.go`:

- observes only sessions for which `AgentInfo.Claude` is present;
- reads only the root `Transcript` path;
- keys its in-memory byte offset by PID;
- primes a new session to end-of-file and emits no historical usage; and
- emits only input, output, combined cache-read, and combined cache-create totals.

`switchboard/internal/transcript/transcript.go` sums every assistant JSONL row that contains usage. Current Claude transcripts can contain multiple streamed assistant rows with the same message ID and identical usage. Those rows must count once. In a recent structural sample, 267 assistant usage rows represented only 148 unique message IDs; bucket overcount was roughly 1.8–2.2 times before considering omitted child transcripts.

Claude's current usage block also contains information the parser drops, including:

- `cache_creation.ephemeral_5m_input_tokens`
- `cache_creation.ephemeral_1h_input_tokens`
- `service_tier`
- `speed`
- `inference_geo`
- `server_tool_use.web_search_requests`
- `server_tool_use.web_fetch_requests`

Subagent transcript files can contain more billable usage than the root file. Ignoring them makes total session usage incomplete.

### Codex collection

The Codex observer already talks to app-server, but it drops billing-relevant fields:

- `internal/provider/codex/protocol.go` omits `Thread.modelProvider`.
- `internal/provider/codex/observer.go` keeps only approval-related thread settings and drops model, model provider, service tier, and effort.
- There is no handler for `thread/tokenUsage/updated`.

The installed stable app-server schema exposes:

- `thread/tokenUsage/updated`, keyed by `threadId` and `turnId`;
- `last` and `total` usage snapshots;
- input, cached-input, cache-write-input, output, reasoning-output, total, and context-window fields;
- thread model, model provider, service tier, and reasoning effort; and
- `account/usage/read {threadId}`, whose response can include per-thread estimated credits and an optional estimated USD amount when that billing route supports one.

`internal/agentgraph.Usage` already models the Codex token buckets, but the observer does not populate them and history does not persist them as usage samples.

Codex rollout JSONL also includes safe structured metadata for model provider, model, effort, incremental/total token usage, and plan type. It is a suitable fallback when app-server data is unavailable.

### Dashboard behavior

`switchboard-dashboard/handler.go` runs `switchboard-ctl timeline --json --plan-window`. A single-provider response is proxied; multi-provider results are decoded and merged in `internal/timeline/merge.go`.

The merge adds `float64 CostUSD` values unconditionally. Missing cost and real zero are therefore indistinguishable. `web/app.js` displays numeric zero as `$0.00`, and the UI currently describes cost as tokens multiplied by current model prices even when prices or usage are absent.

## Pricing-source constraint

Neither vendor's Models API returns prices. "Live API spot rates" therefore cannot mean calling the model-list endpoint and reading a price field.

Implement a provider price-source layer that retrieves the vendors' authoritative pricing publications or provider-native billing estimates, validates the result, and caches the last known good catalog. Every derived amount must retain source URL, retrieval time, effective/as-of time when available, and a content/version hash.

For Codex, `account/usage/read` is preferable to token repricing when it provides a thread estimate because it understands the active billing route. Raw tokens and the API-equivalent calculation must still be retained.

For Claude, the Claude Code/Agent SDK `cost.total_cost_usd` field is a useful comparison signal, not the sole source of truth: Anthropic documents that it is client-computed from bundled price tables and can drift. Anthropic's administrative Usage and Cost API is an aggregate reconciliation source for eligible organizations, not a low-latency per-session feed.

Cloud routes such as Amazon Bedrock, Google Vertex AI, Microsoft Foundry/Azure, or custom OpenAI-compatible providers need their own adapter or an explicit configured override. Never apply first-party Anthropic/OpenAI rates to those routes without labeling the result `api_equivalent_usd` and the assumed price source.

## Cost concepts

Do not expose one ambiguous `cost_usd` as the canonical value. Use these concepts:

| Field | Meaning |
| --- | --- |
| `api_equivalent_usd` | Raw metered usage priced using the selected provider's public on-demand API rates. Useful for comparison even when a subscription paid for the request. |
| `vendor_estimated_usd` | A dollar estimate returned by the vendor for this thread/session, when available. |
| `plan_credits` | Vendor-estimated credits consumed for a subscription/credit billing route. |
| `estimated_billed_usd` | Best supported estimate of incremental dollars actually billed. Null for included subscription use unless the vendor reports a dollar charge. |
| `cost_status` | `estimated`, `included`, `partial`, `stale`, or `unknown`. |

For transition compatibility, `cost_usd` may remain as a nullable alias of `api_equivalent_usd`, but new consumers must use the explicit fields and status. Do not populate the alias when the estimate is unknown.

### Status rules

- `estimated`: all known billable usage is covered by a current catalog or a vendor estimate.
- `included`: the active route is known to be subscription-included and there is no known incremental dollar charge; API-equivalent cost may still be present.
- `partial`: some usage is priced and some model, token bucket, tool, tier, or turn is unpriced.
- `stale`: complete usage was priced with a last-known-good catalog older than the freshness target.
- `unknown`: provider, route, model, usage, or price coverage is insufficient to produce a defensible amount.

`0.00` is valid only when coverage is complete and the arithmetic result is genuinely zero.

## Canonical identity and usage model

The history record must separate the client from execution and billing:

```go
type BillingIdentity struct {
    AgentClient       string // claude, codex
    ExecutionProvider string // anthropic, openai, aws-bedrock, google-vertex, azure, custom
    BillingRoute      string // api, chatgpt_subscription, credits, cloud, unknown
    AccountKind       string // optional, non-secret classification only
    Model             string // exact provider model ID
    ServiceTier       string
    Speed             string
    InferenceGeo      string
    ReasoningEffort   string
}

type UsageDelta struct {
    InputTokens             int64
    CachedInputTokens       int64
    CacheWrite5mInputTokens int64
    CacheWrite1hInputTokens int64
    OutputTokens            int64
    ReasoningOutputTokens   int64
    TotalTokens             int64
    ModelContextWindow      int64
    WebSearchRequests       int64
    WebFetchRequests        int64
}
```

History events also need stable dedup/correlation fields:

- `session_id`
- `thread_id`
- `turn_id` or response/request ID
- provider message ID where one exists
- source kind (`claude_transcript`, `codex_app_server`, or `codex_rollout`)
- event timestamp from the provider record, not merely observation time

Do not persist credentials, account email addresses, prompts, response text, or configuration values that could contain secrets.

### Provider and billing-route resolution

Resolution must be deterministic and explainable:

1. Prefer explicit app-server/thread/transcript provider metadata.
2. Use model-provider configuration only as a fallback.
3. Use model namespace as a weak fallback and mark confidence accordingly.
4. Never infer that `agent_client=codex` means `execution_provider=openai`.
5. Never infer that `agent_client=claude` means `billing_route=api`.
6. Preserve an unknown value when evidence is absent.

The resolver should return evidence/source and confidence so a UI tooltip or diagnostic command can explain the decision.

## Price catalog

Create a provider-independent package in `switchboard`, preferably `internal/pricing`, with these responsibilities:

```go
type Catalog struct {
    Provider    string
    SourceURL   string
    RetrievedAt time.Time
    EffectiveAt *time.Time
    VersionHash string
    Models      map[string]ModelPrice
}

type ModelPrice struct {
    ExactModelID       string
    Aliases            []string
    InputPerMTok       Decimal
    CachedInputPerMTok *Decimal
    CacheWritePerMTok  *Decimal
    CacheWrite5mPerMTok *Decimal
    CacheWrite1hPerMTok *Decimal
    OutputPerMTok      Decimal
    LongContext        []ContextBand
    Tiers              map[string]TierPrice
    ToolCharges        map[string]UnitPrice
}
```

Use integer micros or a decimal representation during calculation. Convert to a JSON number only at the boundary if the existing contract requires it.

### Refresh behavior

- Fetch when no cached catalog exists or the cache is older than six hours.
- Use a short bounded network timeout and conditional requests when supported.
- Parse into a new value, validate required fields and non-negative rates, then atomically replace the cache.
- Keep the last known good catalog when retrieval or validation fails.
- Mark a catalog stale after 24 hours and unknown/unusable after seven days unless an operator explicitly allows older fallback data.
- Ship a bootstrap catalog for offline first use, clearly marked as bundled and stale until refreshed.
- Include a deterministic fixture-based parser test for every source. A vendor page redesign must fail closed, not generate zero prices.
- Provide a diagnostic/refresh command whose output includes source, age, hash, model count, and validation errors.
- Permit explicit provider-specific overrides for cloud/custom routes. Overrides must appear in provenance.

Exact model ID lookup is the default. Aliases must be explicit data in the catalog; broad family substring matching is prohibited.

## Calculation rules

### Claude

For a single message/response and exact pricing dimension:

```text
api_equivalent =
    input_tokens             × input_rate
  + cache_read_input_tokens  × cache_read_rate
  + cache_write_5m_tokens    × cache_write_5m_rate
  + cache_write_1h_tokens    × cache_write_1h_rate
  + output_tokens            × output_rate
  + metered_tool_units       × tool_unit_rate
```

Apply service-tier, fast-mode, inference-geography, context-band, or cloud-provider prices at the response level. Do not aggregate tokens across differently priced responses before applying rates.

If only combined cache creation is available, price what can be defended and return `partial`; do not silently assume every write used the 5-minute TTL.

### Codex/OpenAI

For a single turn/response:

```text
uncached_input = max(0, input_tokens - cached_input_tokens - cache_write_input_tokens)

api_equivalent =
    uncached_input          × input_rate
  + cached_input_tokens    × cached_input_rate
  + cache_write_input_tokens × cache_write_rate
  + output_tokens          × output_rate
  + metered_tool_units     × tool_unit_rate
```

Reasoning output tokens are a subset/breakdown of output tokens and must not be charged a second time.

Long-context thresholds and service tiers are request-level properties. Preserve per-turn deltas and price each turn before summing. Never choose a long-context rate from an aggregate session total.

When app-server returns a vendor thread estimate:

- store `estimatedUsageCreditsMicros` as plan credits;
- store `estimatedUsageUsdMicros` as `vendor_estimated_usd` when non-null;
- retain the model/effort/speed usage groups;
- use deltas between monotonic totals so repeated reads do not double count; and
- prefer the vendor estimate for `estimated_billed_usd` when its billing route and coverage are explicit.

## Claude ingestion requirements

1. Deduplicate assistant fragments by provider message ID across poll boundaries. The cursor must remember enough IDs/fingerprints that a message split between reads is still counted once.
2. Count the final authoritative usage for a message. If later fragments revise usage, record only the positive delta from the prior value rather than the whole total again.
3. Discover and ingest every transcript belonging to the root session, including child-agent transcript files. Key cursors by stable session plus transcript identity/path, not PID alone.
4. Persist cursor/dedup state so daemon restart does not lose or replay usage.
5. On first discovery, backfill complete records from offset zero using provider timestamps. Do not attribute a whole backlog to daemon startup time.
6. Preserve exact model and all distinct usage/tier/tool buckets.
7. Aggregate only after identity, deduplication, and price dimensions have been preserved.
8. Maintain bounded state and handle truncation/replacement without negative deltas.

Required tests:

- repeated identical message ID counts once;
- usage revised upward for the same message ID counts only the increase;
- a duplicate split across two poll calls counts once;
- root and child transcript usage both count;
- daemon restart neither loses nor replays a completed message;
- transcript truncation/replacement is safe;
- 5-minute and 1-hour cache writes remain distinct;
- service tier, speed, geography, and tool units survive parsing;
- two exact models in one session remain separate pricing groups.

## Codex ingestion requirements

1. Decode thread model provider, model, service tier, and reasoning effort from app-server.
2. Subscribe to/handle `thread/tokenUsage/updated` and retain `last`, `total`, context window, `threadId`, and `turnId`.
3. Emit only `last` usage as the event delta, or compute a guarded monotonic delta from `total` when `last` is absent. Deduplicate by thread/turn/update fingerprint.
4. Populate canonical agent-graph usage and persist a history `usage_sample` for Codex.
5. Add a bounded `account/usage/read` query path and preserve estimated USD, credits, and usage groups when returned.
6. Detect billing route from explicit account/session metadata without persisting secrets or personal account fields.
7. Use Codex rollout JSONL as a fallback source when app-server is unavailable; never count both sources for the same turn.
8. Preserve exact model/provider/tier at the turn level.

Required tests:

- app-server notification decoding matches the installed stable schema;
- repeated totals do not double count;
- separate turns with equal token values both count;
- reasoning tokens are retained but not double charged;
- provider/model/tier survive into history;
- app-server and rollout observations deduplicate;
- API-key and subscription/credit routes produce different billing semantics;
- a nullable vendor USD estimate remains null, not zero.

## History and timeline contract

Extend `usage_sample` compatibly. Keep the legacy token fields during migration, but add canonical usage, identity, source, and correlation fields. A sample should carry either a computed `CostEstimate` or enough information to reproduce one from a versioned price catalog.

Recommended JSON shape:

```json
{
  "agent": "codex",
  "execution_provider": "openai",
  "billing_route": "chatgpt_subscription",
  "model": "gpt-5.6-sol",
  "service_tier": "standard",
  "thread_id": "...",
  "turn_id": "...",
  "usage": {
    "input_tokens": 1000,
    "cached_input_tokens": 600,
    "cache_write_input_tokens": 0,
    "output_tokens": 200,
    "reasoning_output_tokens": 80
  },
  "cost": {
    "api_equivalent_usd": 0.0052,
    "vendor_estimated_usd": null,
    "plan_credits": 42.0,
    "estimated_billed_usd": null,
    "status": "included",
    "coverage": 1.0,
    "pricing_source": "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    "pricing_retrieved_at": "2026-08-25T00:00:00Z",
    "pricing_version": "sha256:..."
  }
}
```

Aggregation rules:

- sum numeric amounts only within the same semantic field;
- carry null when no component has an estimate;
- report `partial` if any included component is unpriced;
- report coverage, unpriced event count, and unpriced token/tool units;
- retain the oldest catalog retrieval time or explicit mixed-version marker for a total;
- never let one provider's absent estimate become a zero during dashboard merge.

Historical events should be priced using the catalog/effective price applicable to their provider timestamp where a historical catalog is available. If only today's spot rate is available, label the result `spot_estimate` and retain the pricing timestamp; do not imply it is the historical invoice amount.

## Dashboard contract and presentation

Update `switchboard-dashboard/internal/timeline/types.go`, `merge.go`, `docs/provider-contract.md`, and `web/app.js` to preserve the richer cost object.

Presentation requirements:

- Show API equivalent and estimated billed cost as separate labels.
- Display `—` for unknown, never `$0.00`.
- Mark partial or stale totals visibly and expose coverage/source/as-of details in accessible text or a tooltip.
- For subscription-included Codex usage, use wording such as `Included · $X API equivalent`; do not claim `$0 billed` unless that fact is supported.
- Identify `Claude via Anthropic`, `Claude via Bedrock`, `Codex via OpenAI`, or the resolved equivalent when available.
- Multi-provider merge must preserve nullability, statuses, unpriced counts, and mixed-source metadata.
- Keep a compatibility path for older provider payloads, but label legacy numeric-only cost as `legacy estimate`.

## Migration and backfill

- Add a schema/version marker to history records or cost payloads.
- Readers must continue to accept existing history lines.
- Do not retroactively treat old combined Claude cache-write totals as fully accurate. Repricing them is partial.
- Add a one-shot safe backfill/reindex command for local transcripts/rollouts. It should write idempotent events with stable dedup keys and support dry-run reporting.
- Preserve raw usage so catalog updates can reprice estimates without rereading provider transcripts.
- Do not rewrite or delete the existing history log during the first rollout.

## Workstreams

### A. Claude usage correctness

Primary ownership:

- `switchboard/internal/transcript/`
- Claude-specific cursor/discovery code in `switchboard/cmd/switchboard/fanout.go`
- focused tests in those packages

Deliver deduplication, child transcript inclusion, durable stable cursors/backfill behavior, and the expanded Claude usage dimensions. Avoid owning the generic price catalog or dashboard.

### B. Codex telemetry and billing metadata

Primary ownership:

- `switchboard/internal/provider/codex/`
- Codex fields in `switchboard/internal/agentgraph/`
- focused observer/protocol fixtures and tests

Deliver app-server token notifications, thread/model/provider/tier metadata, vendor usage-read support, and a rollout fallback. Avoid owning the generic price catalog or dashboard. If generic history changes are required, keep them minimal and clearly isolate them for integration.

### C. Price catalog, cost engine, and history aggregation

Primary ownership:

- new `switchboard/internal/pricing/`
- `switchboard/internal/history/history.go`
- `switchboard/internal/history/pricing.go`
- `switchboard/internal/history/timeline.go`
- relevant `switchboard-ctl` output/tests

Deliver source adapters, cache/provenance, exact-model lookup, canonical estimate semantics, nullable/partial aggregation, and a diagnostic refresh path. Own the shared history schema to minimize conflicts.

### D. Dashboard contract and UI

Primary ownership:

- `switchboard-dashboard/internal/timeline/`
- `switchboard-dashboard/web/`
- `switchboard-dashboard/docs/provider-contract.md`
- handler/merge/UI tests

Deliver backward-compatible decoding, correct multi-provider merge, explicit labels/statuses, and source/freshness disclosure.

## Integration order

1. Land workstream C's canonical types and compatibility readers.
2. Rebase or adapt workstreams A and B onto those types; connect both collectors to canonical history events.
3. Run all `switchboard` tests and fixture tests, then manually inspect timeline JSON for Claude and Codex sessions using only non-content metadata.
4. Land workstream D against the final timeline schema.
5. Run dashboard Go tests and browser/unit tests.
6. Exercise offline, stale-catalog, unknown-model, subscription, API-key, mixed-provider, and legacy-provider cases.
7. Compare aggregate estimates with provider administrative usage/cost data where credentials and permissions are available; reconciliation is validation, not an excuse to ingest secrets.

## Definition of done

- A new Codex session produces raw per-turn usage in timeline/history.
- A Claude session with streamed duplicate fragments is counted once per logical provider message.
- Claude child-agent usage is included exactly once.
- Every priced sample records exact client, execution provider, billing route, model, price source, price version, and freshness.
- Claude cache TTL buckets and Codex cached/cache-write/reasoning buckets are preserved.
- Current official rate data is refreshed and validated; offline last-known-good behavior is tested.
- Exact unknown models and unsupported cloud routes produce `partial` or `unknown`, never silent zero.
- API-equivalent, vendor-estimated, credits, and estimated-billed concepts remain separate through CLI, JSON, dashboard merge, and UI.
- Long-context/tier/fast/regional pricing is applied per response or clearly reported as unpriced.
- Multi-provider totals preserve status and coverage.
- Existing history remains readable.
- Focused tests, full Go tests, formatting, and diff checks pass in both repositories.

## Authoritative references

Anthropic:

- Pricing: <https://platform.claude.com/docs/en/about-claude/pricing>
- Models API (does not expose prices): <https://platform.claude.com/docs/en/api/models/list>
- Claude Code/Agent SDK cost tracking caveat: <https://code.claude.com/docs/en/agent-sdk/cost-tracking>
- Usage and Cost Admin API: <https://platform.claude.com/docs/en/manage-claude/usage-cost-api>

OpenAI/Codex:

- Current model pricing pages: <https://developers.openai.com/api/docs/models/all>
- GPT-5.6 Sol model and token pricing: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>
- Models API retrieve schema (does not expose prices): <https://developers.openai.com/api/reference/typescript/resources/models/methods/retrieve>
- Codex authentication and billing routes: <https://learn.chatgpt.com/docs/auth>
- Codex pricing/credits: <https://learn.chatgpt.com/docs/pricing>
- Codex model-provider and service-tier configuration: <https://learn.chatgpt.com/docs/config-file/config-reference>
- OpenAI organization Costs API: <https://developers.openai.com/api/reference/python/resources/admin/subresources/organization/subresources/usage>

## Guardrails for implementation agents

- Do not inspect prompts, response content, environment files, secrets, credentials, or personal account identifiers.
- Do not modify or delete existing user worktree changes.
- Work in an isolated worktree and commit the bounded workstream.
- Use provider schemas and synthetic fixtures for tests; do not copy private transcript content into the repository.
- Fail closed when a source cannot be parsed or identity cannot be resolved.
- Report the commit SHA, changed files, tests run, remaining limitations, and any integration assumptions.

## Implementation completion record

Completed: 2026-08-25

Review branches:

- `switchboard`: <https://github.com/tjmisko/switchboard/tree/cost-audit-integration-20260825>
- `switchboard-dashboard`: <https://github.com/tjmisko/switchboard-dashboard/tree/cost-audit-dashboard-20260825>

The upstream integration head is `9a88123a53fbd71e1e3eb79aaeae765fa961e72d`.
No service was restarted and neither branch was merged to `main`; deployment remains a reviewer/operator action.

### Delivered behavior

The implementation replaces the ambiguous scalar cost with four independent,
nullable concepts: public API-equivalent USD, vendor-estimated USD, plan credits,
and supported estimated billed USD. Cost status, priced/unpriced units, reasons,
catalog age, official source URLs, semantic catalog hash, and mixed-version
provenance survive history folding, multi-provider merge, and browser rendering.
An unknown amount renders as an em dash; it is never coerced to `$0.00`.

The daemon now refreshes credential-free pricing publications immediately at
startup and every six hours. The refresh uses a bounded HTTP client,
conditional requests, schema/semantic validation, an atomic last-known-good
cache, a 24-hour stale threshold, and a seven-day fail-closed cutoff. Operators
can inspect or force it with `switchboard-ctl pricing status|refresh`.

Neither vendor exposes price fields from its Models API. "Live API spot rates"
therefore means the vendors' current first-party public API pricing
publications, not a model-list call. The adapters fetch:

- <https://platform.claude.com/docs/en/about-claude/pricing>
- <https://developers.openai.com/api/docs/pricing>
- the exact OpenAI model pages for `gpt-5.6-sol`, `gpt-5.6-terra`, and
  `gpt-5.6-luna`

The parsers validate the currently material billing semantics as well as the
numbers: exact model rows, cache-write rules, context thresholds, fast mode,
regional/data-residency uplift, Anthropic cache TTL multipliers, the full-context
standard-rate statement, web-search pricing, and code-execution-with-web
behavior. A missing or changed marker rejects the refresh and retains the last
known good catalog.

Claude collection now:

- reads the root and exact child transcript set;
- collapses streamed revisions by provider message identity;
- emits full authoritative snapshots with restart-safe stable IDs and monotonic
  revisions;
- fsyncs idempotent history before advancing its content-free cursor;
- preserves exact model, provider timestamp, service tier, speed, inference
  geography, cache reads, 5-minute and 1-hour cache writes, web search/fetch,
  code execution, and future unrecognized server-tool counters; and
- emits a durable partial-coverage cutover instead of pretending pre-upgrade
  transcript usage was observed.

A Claude Code transcript proves the client and exact model but not whether the
request used Anthropic, Bedrock, Vertex, Foundry, or another configured backend.
Execution provider and billing route therefore remain unknown unless future
trusted metadata proves them. An exact model can still select the unique
Anthropic public catalog for an explicitly partial API-equivalent comparison;
it never becomes an estimated invoice. Priority capacity is treated as contract
pricing: public standard/fast rates remain a comparator, while estimated billed
USD stays null. Server-side code execution without enough duration/allowance
evidence and unknown future server-tool counters are unpriced components.

Codex collection now:

- retains app-server model provider, exact model, tier/speed, effort, auth mode,
  coarse account kind, and vendor thread-usage estimates;
- binds every exact root/child rollout path supplied by trusted hooks without
  guessing paths or scanning private content;
- uses a bounded whitelist-only JSONL decoder and never logs or persists prompt,
  response, path, credential, or account-identifier content;
- reconciles cumulative and last-token snapshots, equal-total metadata
  revisions, reroutes, counter regressions, restarts, file replacement, and
  replay ambiguity;
- persists canonical history synchronously and idempotently before advancing a
  hashed durable cursor; and
- invalidates account-derived enrichment on every app-server reconnect so an
  account switch cannot inherit an old API/cloud route.

App-server token notifications remain an advisory graph signal; rollout history
is the canonical accounting source so the same turn is not persisted twice.
Because Codex rollout counters do not expose potentially billable provider tool
units, every public API-equivalent token calculation is labeled `tokens_only`
and therefore partial, regardless of whether authentication uses an API key,
ChatGPT, credits, or an unknown route. `account/usage/read` cumulative credits
and optional USD remain a separate provider-native snapshot and are never added
to the token subtotal.

History's durable sink now has restart-idempotent latest-revision indexing,
short-write rollback, file and directory fsync acknowledgement, safe concurrent
close behavior, and a batch compatibility path for Claude. Cumulative vendor
snapshots are latest-wins per provider/root/thread scope rather than additive.
They are intentionally omitted from bounded plan-window totals when no
defensible baseline exists.

### Commit inventory

`switchboard` integration commits, oldest first:

- `d9ebe27` — capture Codex provider usage and billing metadata
- `93b8d17` — provider-aware live pricing foundation
- `82464ca` — latest-wins cumulative vendor usage folding
- `7748a66` — explicit collector coverage gaps
- `ca4bae0` — restart-safe Claude transcript accounting
- `0ff569e` — durable usage snapshot upserts
- `fecef8d` — safe durable sink close lifecycle
- `ca6ebfa` — durable Claude transcript integration
- `68c35c5` — monotonic Claude revisions across eviction
- `9eedb6d` — canonical Claude billable usage
- `4621d1e` — preserve uncertain execution/billing routes
- `ebcb464` — fail closed on changed Claude context pricing
- `39e03d2` — separate Anthropic Priority contract billing
- `d48ffa1` — durable Codex rollout ingestion and sink integration
- `ff21f4d` — fail closed on server-tool charges
- `9a88123` — mark every Codex rollout API-equivalent as token-only

`switchboard-dashboard` source-worktree commits:

- `2f3d060` — initial audit and agent handoff
- `fd0a19f` — nullable provider cost semantics and UI labels
- `1caf687` — canonical cost-schema alignment
- `e5c728c` — pricing-group and vendor-usage preservation
- `6640c6c` — honest unquantified-gap labels
- `03ea896` — collector coverage provenance
- `ecb1acd` — server-tool coverage preservation

The dashboard review branch cherry-picks only these cost-audit commits onto
`origin/main`; unrelated local work is not part of the review branch.

### Verification record

Passing upstream checks:

```text
go test ./internal/pricing ./internal/transcript ./internal/history ./internal/provider/codex ./internal/state
go test ./cmd/switchboard -run '^(TestObserveUsage|TestProductionCodexConfig|TestCodexRootAndChildHooksBind|TestRollout)'
go test ./cmd/switchboard-ctl -run '^TestPricing'
go test -race ./internal/pricing ./internal/transcript ./internal/history ./internal/provider/codex ./internal/state
go test -race ./cmd/switchboard -run '^(TestObserveUsage|TestProductionCodexConfig|TestCodexRootAndChildHooksBind|TestRollout)'
go vet ./internal/pricing ./internal/transcript ./internal/history ./internal/provider/codex ./internal/state ./cmd/switchboard
git diff --check
```

Passing dashboard checks:

```text
go test ./...
node --test --test-reporter=dot web/model.test.js
node --check web/model.js
node --check web/app.js
git diff --check
```

The complete upstream `go test ./...` was also attempted. Its new/touched cost
packages pass, but the repository-wide command cannot be green in this managed
environment: existing Unix-socket tests fail with `socket: operation not
permitted`, and the existing no-repository project-root test resolves the
surrounding `/tmp` worktree. These failures are outside the changed cost path.

The current official HTML publications were inspected on 2026-08-25 and agree
with the fixtures and bootstrap catalog. A real `pricing refresh` invocation
could not reach the vendor domains from the command sandbox's network allowlist,
so live HTTP execution must be exercised after checkout in the normal daemon
environment. Refresh/parser failure is non-destructive and visibly falls back
to stale or unusable LKG state.

### Remaining limitations and review decisions

- Estimates reprice historical usage at the catalog identified as a current
  `spot_estimate`; this is not an invoice and no historical price archive was
  invented.
- Cloud/custom routes have no adapter yet. Bedrock, Vertex, Foundry/Azure,
  custom OpenAI-compatible providers, unsupported models, OpenAI `ultrafast`,
  and unimplemented batch routes remain explicitly unknown.
- Claude actual execution provider, billing route, negotiated discounts,
  organization code-execution allowance, and invoice reconciliation cannot be
  proven from the local transcript alone.
- Codex ChatGPT authentication does not prove subscription inclusion or zero
  incremental billing. Native credits/USD are shown when returned; otherwise
  billed USD remains null.
- Codex tool-unit API equivalence remains partial until a trusted source exposes
  those units. A distinct child rollout is collected only after its trusted hook
  supplies the exact path.
- Provider-ID-less Claude rows cannot be deduplicated across distinct files;
  same-size middle-only rewrites can evade the transcript anchor. Both cases
  fail conservatively where observable rather than using content heuristics.
- Pre-cutover history is retained and explicitly partial. No existing history
  was rewritten or deleted, and no private transcript, prompt, response,
  credential, environment file, or personal account identifier was inspected.

## Deployment execution record

Attempted: 2026-08-25

### Deployment plan and locked inputs

Deployment was deliberately locked to the reviewed, pushed heads rather than
building from either repository's moving `main` branch:

- Switchboard daemon and CLI source: `9a88123a53fbd71e1e3eb79aaeae765fa961e72d`
- Dashboard source: `83fc260e0fefce5522036de69091b69ea02d0761`

This kept unrelated local commits and worktree changes out of the release. The
installed systemd configuration was inspected before installation. The daemon
unit resolves `SWITCHBOARD_BIN` to `%h/.config/switchboard/bin/switchboard` via
its existing `local-binary.conf` drop-in. The dashboard unit formerly resolved
the dashboard and CLI from `%h/go/bin`.

The release sequence was:

1. inspect the installed units, drop-ins, old binary metadata, and service paths;
2. build immutable artifacts from the two reviewed worktrees;
3. run focused non-race and race tests, dashboard tests, JavaScript model tests,
   syntax checks, and vet;
4. copy the artifacts to same-filesystem temporary names, compare them byte for
   byte, and atomically rename them into the service-owned binary directory;
5. reload and restart only `switchboard.service` and
   `switchboard-dashboard.service`; and
6. force a first-party price refresh, inspect freshness diagnostics, and verify
   provider/cost fields in a real timeline response.

Steps 1 through 4 completed. Steps 5 and 6 reached a managed-environment
boundary described below.

### Release gate

The first invocation could not use Go's default build cache because that cache
is read-only in the managed environment. It failed during package setup, before
compilation or test execution. The same commands were rerun with
`GOCACHE=/tmp/switchboard-cost-gocache`.

Passing Switchboard checks:

```text
go test ./internal/pricing ./internal/transcript ./internal/history ./internal/provider/codex ./internal/state
go test -race ./internal/pricing ./internal/transcript ./internal/history ./internal/provider/codex ./internal/state
go test ./cmd/switchboard -run 'Pricing|Usage|Fanout|Codex'
go test ./cmd/switchboard-ctl -run 'Pricing|Timeline|Cost|Usage'
go vet ./internal/pricing ./internal/transcript ./internal/history ./internal/provider/codex ./internal/state ./cmd/switchboard ./cmd/switchboard-ctl
```

Passing dashboard checks:

```text
go test ./...
node web/model.test.js
node --check web/app.js
node --check web/model.js
go vet ./...
```

The dashboard linked worktree could not obtain Go VCS status during its first
standalone build. It was rebuilt with `-buildvcs=false`; the immutable source
SHA above is the authoritative provenance recorded for the artifact.

Release artifact hashes:

```text
4955d77ad300682a624b9ae3f9778e25ae77e6be5e897fee324d66d913822fb5  switchboard
c07dc290863709434b6b75b3b38de5d5c456515e7e963dea02b275b845719204  switchboard-ctl
bcf3dfaf15e3cfd3d916ef1c872a4b048b33fc91bf5a045a7d50219caef96010  switchboard-dashboard
```

### Installed state

`%h/go/bin` is mounted read-only to this managed execution environment, so the
release was installed into Switchboard's existing private development binary
directory instead:

```text
%h/.config/switchboard/bin/switchboard
%h/.config/switchboard/bin/switchboard-ctl
%h/.config/switchboard/bin/switchboard-dashboard
```

All three installed files match the staged hashes above. The prior daemon and
CLI were copied before replacement to:

```text
%h/.config/switchboard/bin/.switchboard-backup-20260825-9a88123/
```

The old dashboard remains untouched at `%h/go/bin/switchboard-dashboard`. The
dashboard's existing non-destructive systemd override now points both executable
paths at `%h/.config/switchboard/bin`, while retaining its existing merged
provider configuration.

The installed new CLI runs and reports both bundled catalogs, with 15 Anthropic
models and 3 OpenAI models. As expected before first live refresh, both catalogs
are explicitly `stale`, `needs_refresh=true`, and `used_fallback=true`; no value
is misrepresented as live.

### Activation boundary and exact handoff

The environment blocks connections to `/run/user/1000/bus`, including approved
elevated `systemctl --user` and systemd's `.host` machine transport. It also
hides the service PIDs through the PID namespace. The service cgroups expose
only a force-kill control; that was intentionally not used because it would
turn a normal deployment into a SIGKILL and could discard in-flight state.

The same network policy blocks the fixed Anthropic and OpenAI pricing domains
before the installed refresher receives an HTTP response. Consequently, the
artifacts and unit override are installed but the already-running processes
have not loaded them, and live HTTP freshness/end-to-end cost output has not yet
been claimed as verified.

Run these commands in the normal host session to finish the graceful boundary:

```bash
systemctl --user daemon-reload
systemctl --user restart switchboard.service switchboard-dashboard.service
~/.config/switchboard/bin/switchboard-ctl pricing refresh --json
~/.config/switchboard/bin/switchboard-ctl pricing status --json
systemctl --user show switchboard.service switchboard-dashboard.service \
  -p ActiveState -p SubState -p MainPID -p ExecMainStartTimestamp -p Result
```

Acceptance requires both services to be `active/running`, both pricing
diagnostics to report `fresh` with `used_fallback=false`, and a subsequent real
timeline response to preserve provider identity, nullable cost semantics,
catalog source/hash, pricing kind, and coverage/completeness fields. Codex rows
must remain `tokens_only`/partial rather than implying provider-tool coverage;
an unproved billing route or amount must remain null rather than `$0`.
