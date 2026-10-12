package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/tjmisko/switchboard-dashboard/internal/provider"
	"github.com/tjmisko/switchboard-dashboard/internal/timeline"
)

// Run against the exact CLI intended for deployment:
// SWITCHBOARD_TEST_CTL=/path/to/switchboard-ctl go test -run TestPricingProviderContract
// All history is synthetic. Expired catalogs may make cost unknown; missing
// structured accounting, duplicate usage, or fabricated zeroes must still fail.
func TestPricingProviderContract(t *testing.T) {
	ctl := os.Getenv("SWITCHBOARD_TEST_CTL")
	if ctl == "" {
		t.Skip("set SWITCHBOARD_TEST_CTL to verify an actual Switchboard build")
	}
	dir := t.TempDir()
	const events = `{"ts":"2026-08-25T12:00:00Z","type":"session_start","session_id":"cost-contract","pid":1,"agent":"claude"}
{"schema_version":2,"ts":"2026-08-25T12:01:00Z","type":"usage_sample","session_id":"cost-contract","pid":1,"agent":"claude","model":"claude-opus-4-8","usage_event_id":"message-1","usage_snapshot":true,"usage_revision":1,"usage":{"input_tokens":1000000}}
{"schema_version":2,"ts":"2026-08-25T12:01:00Z","type":"usage_sample","session_id":"cost-contract","pid":1,"agent":"claude","model":"claude-opus-4-8","usage_event_id":"message-1","usage_snapshot":true,"usage_revision":2,"usage":{"input_tokens":2000000}}
{"schema_version":2,"ts":"2026-08-25T12:02:00Z","type":"usage_sample","session_id":"cost-contract","pid":1,"agent":"claude","model":"unpriced-test-model","usage_event_id":"message-2","usage_snapshot":true,"usage_revision":1,"usage":{"input_tokens":1000000}}
{"ts":"2026-08-25T12:03:00Z","type":"session_end","session_id":"cost-contract","pid":1,"agent":"claude"}
`
	if err := os.WriteFile(filepath.Join(dir, "2026-08-25.jsonl"), []byte(events), 0o600); err != nil {
		t.Fatal(err)
	}
	empty := writeStub(t, "#!/bin/sh\nprintf '%s' '{\"lanes\":[],\"totals\":{}}'\n")
	for _, merged := range []bool{false, true} {
		name := "single"
		if merged {
			name = "merged"
		}
		t.Run(name, func(t *testing.T) {
			srv := &Server{Ctl: ctl, Dir: dir}
			if merged {
				srv.Providers = []provider.Provider{
					provider.NewSubprocessProvider("switchboard", "Switchboard", []string{ctl, "timeline", "--json", "--plan-window"}, dir, provider.Capabilities{}),
					provider.NewSubprocessProvider("empty", "Empty", []string{empty}, "", provider.Capabilities{}),
				}
			}
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/timeline?day=2026-08-25", nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("timeline returned %d: %s", rec.Code, rec.Body.String())
			}
			var got timeline.Timeline
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if len(got.Lanes) != 1 || got.Totals.TokIn != 3_000_000 || got.Lanes[0].TokIn != 3_000_000 {
				t.Fatalf("expected one lane and latest-revision usage of 3M tokens: %s", rec.Body.String())
			}
			for _, cost := range []*timeline.CostEstimate{got.Totals.Cost, got.Lanes[0].Cost} {
				if cost == nil || cost.Legacy || (cost.Status != "partial" && cost.Status != "unknown") {
					t.Fatalf("missing structured, incomplete cost: %+v", cost)
				}
				if len(cost.UnpricedReasons) == 0 || (cost.APIEquivalentUSD != nil && *cost.APIEquivalentUSD <= 0) {
					t.Fatalf("unpriced usage must remain explicit, with no fabricated zero: %+v", cost)
				}
			}
		})
	}
}
