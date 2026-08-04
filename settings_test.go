package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func writeSettings(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "dashboard.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatalf("write settings: %v", err)
	}
	return p
}

func TestLoadSettingsShouldReturnDefaultsWhenTheFileIsAbsent(t *testing.T) {
	got, err := LoadSettings(filepath.Join(t.TempDir(), "nope.json"))
	if err != nil {
		t.Fatalf("absent settings file should not error: %v", err)
	}
	if got != DefaultSettings() {
		t.Fatalf("got %+v, want defaults %+v", got, DefaultSettings())
	}
}

func TestLoadSettingsShouldKeepDefaultsForKeysTheFileOmits(t *testing.T) {
	got, err := LoadSettings(writeSettings(t, `{"away_after_ms": 600000}`))
	if err != nil {
		t.Fatalf("LoadSettings: %v", err)
	}
	if got.AwayAfterMs != 600000 {
		t.Errorf("away_after_ms = %d, want the file's 600000", got.AwayAfterMs)
	}
	def := DefaultSettings()
	if got.SwitchRecoveryMs != def.SwitchRecoveryMs || got.SwitchFlickerMs != def.SwitchFlickerMs || got.MinEngageMs != def.MinEngageMs {
		t.Errorf("omitted keys should keep defaults, got %+v", got)
	}
}

func TestLoadSettingsShouldRejectNonPositiveValuesInFavorOfDefaults(t *testing.T) {
	got, err := LoadSettings(writeSettings(t, `{"away_after_ms": 0, "switch_recovery_ms": -5}`))
	if err != nil {
		t.Fatalf("LoadSettings: %v", err)
	}
	def := DefaultSettings()
	if got.AwayAfterMs != def.AwayAfterMs || got.SwitchRecoveryMs != def.SwitchRecoveryMs {
		t.Fatalf("non-positive values should fall back to defaults, got %+v", got)
	}
}

func TestLoadSettingsShouldErrorOnAMalformedFile(t *testing.T) {
	// a present-but-broken file means you tried to configure something and it
	// did not take — that must be loud, not silently defaulted.
	if _, err := LoadSettings(writeSettings(t, `{"away_after_ms":`)); err == nil {
		t.Fatal("expected an error for malformed settings JSON")
	}
}

func TestHandleSettingsShouldServeTheConfiguredValues(t *testing.T) {
	srv := &Server{Ctl: "unused", Settings: Settings{
		AwayAfterMs: 600000, SwitchRecoveryMs: 45000, SwitchFlickerMs: 400, MinEngageMs: 10000,
	}}

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/settings", nil))

	if rec.Result().StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Result().StatusCode)
	}
	var got Settings
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("settings body not json: %v (%q)", err, rec.Body.String())
	}
	if got.AwayAfterMs != 600000 || got.SwitchRecoveryMs != 45000 {
		t.Fatalf("got %+v, want the server's configured settings", got)
	}
}

func TestHandleSettingsShouldServeDefaultsForAnUnconfiguredServer(t *testing.T) {
	// the frontend's built-in fallbacks are these same numbers, so an embedder
	// that never called LoadSettings must not ship it zeros.
	rec := httptest.NewRecorder()
	(&Server{Ctl: "unused"}).Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/settings", nil))

	var got Settings
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("settings body not json: %v", err)
	}
	if got != DefaultSettings() {
		t.Fatalf("got %+v, want defaults %+v", got, DefaultSettings())
	}
}
