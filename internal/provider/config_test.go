package provider

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "providers.json")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return p
}

func TestLoadConfig_shouldBuildOrderedProvidersFromValidFile(t *testing.T) {
	p := writeConfig(t, `{"providers":[
		{"id":"claude","label":"Claude","exec":["switchboard-ctl","timeline","--json","--plan-window"],"capabilities":{"plan":true}},
		{"id":"arachne","exec":["arachne-ctl","timeline","--json"],"dir":"/hist","capabilities":{"plan":false}}
	]}`)
	cfg, err := LoadConfig(p)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	provs, err := cfg.Build()
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if len(provs) != 2 {
		t.Fatalf("expected 2 providers, got %d", len(provs))
	}
	if provs[0].ID() != "claude" || provs[1].ID() != "arachne" {
		t.Fatalf("provider order not preserved: %s, %s", provs[0].ID(), provs[1].ID())
	}
	if !provs[0].Capabilities().Plan {
		t.Fatalf("claude should advertise plan capability")
	}
	if provs[1].Capabilities().Plan {
		t.Fatalf("arachne should not advertise plan capability")
	}
	// label defaults to id when omitted.
	if provs[1].Label() != "arachne" {
		t.Fatalf("missing label should default to id, got %q", provs[1].Label())
	}
}

func TestLoadConfig_shouldRejectInvalidConfigs(t *testing.T) {
	cases := map[string]string{
		"empty providers": `{"providers":[]}`,
		"missing id":      `{"providers":[{"exec":["x"]}]}`,
		"empty exec":      `{"providers":[{"id":"a","exec":[]}]}`,
		"duplicate id":    `{"providers":[{"id":"a","exec":["x"]},{"id":"a","exec":["y"]}]}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			p := writeConfig(t, body)
			if _, err := LoadConfig(p); err == nil {
				t.Fatalf("expected error for %s", name)
			}
		})
	}
}

func TestLoadConfig_shouldErrorOnMissingFile(t *testing.T) {
	if _, err := LoadConfig(filepath.Join(t.TempDir(), "nope.json")); err == nil {
		t.Fatalf("expected error for missing file")
	}
}

func TestLoadConfig_shouldErrorOnMalformedJSON(t *testing.T) {
	p := writeConfig(t, `{not json`)
	_, err := LoadConfig(p)
	if err == nil || !strings.Contains(err.Error(), "parse providers config") {
		t.Fatalf("expected parse error, got %v", err)
	}
}
