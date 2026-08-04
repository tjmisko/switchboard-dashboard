package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Settings are the operator-model tunables the frontend reads at boot. They are
// judgement calls about YOUR working habits, not facts about the data, so they
// live in a file you own rather than in the frontend's source: how long after a
// keystroke you still count as sitting at a focused agent window, how long a
// context switch costs you, and what counts as a switch at all.
//
// Every field is a duration in milliseconds. A field absent from the file keeps
// its default, so a settings file may set only what it wants to change; an
// absent file means "all defaults".
type Settings struct {
	// AwayAfterMs: with an agent window focused but no keyboard or mouse
	// activity for this long, you are inferred to be AWAY — the window is up,
	// you are not. Below it you count as attending (present at the window),
	// which is charged as your own time. Raise it if you read for long stretches
	// without touching anything; lower it if walking away mid-session is common.
	AwayAfterMs int64 `json:"away_after_ms"`

	// SwitchRecoveryMs: how long re-acquiring context costs you after a switch.
	// Windows are UNIONED, so a burst of switches inside one window costs one
	// recovery rather than one apiece.
	SwitchRecoveryMs int64 `json:"switch_recovery_ms"`

	// SwitchFlickerMs: minimum dwell for a focus arrival to count as a real
	// context switch. Below it, the arrival is focus flicker (a notification,
	// focus-follows-mouse) and is ignored by the count, the overlay, and the
	// recovery charge alike.
	SwitchFlickerMs int64 `json:"switch_flicker_ms"`

	// MinEngageMs: minimum focus dwell to count as attending at all. Separate
	// from SwitchFlickerMs: passing through a window is a switch, but it is not
	// time spent working in it.
	MinEngageMs int64 `json:"min_engage_ms"`
}

// DefaultSettings are what ships. They are also the fallback baked into the
// frontend, so a dashboard served without this endpoint behaves identically.
func DefaultSettings() Settings {
	return Settings{
		AwayAfterMs:      5 * 60 * 1000, // 5 minutes
		SwitchRecoveryMs: 90 * 1000,     // 90 seconds
		SwitchFlickerMs:  500,           // half a second
		MinEngageMs:      15 * 1000,     // 15 seconds
	}
}

// DefaultSettingsPath is where settings live when --settings is not given.
// Missing is the normal case and means "all defaults".
func DefaultSettingsPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "switchboard", "dashboard.json")
}

// LoadSettings reads path over the defaults. A missing file is not an error —
// it is the unconfigured case. A present but malformed file IS an error: it
// means you tried to configure something and it didn't take, which should be
// loud rather than silently ignored.
//
// Any field set to a non-positive value falls back to its default; a zero
// recovery window or a negative away threshold would silently disable the
// accounting the fields exist to drive.
func LoadSettings(path string) (Settings, error) {
	out := DefaultSettings()
	if path == "" {
		return out, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return out, nil
		}
		return out, fmt.Errorf("read settings %s: %w", path, err)
	}
	// decode onto the defaults, so absent keys keep them
	if err := json.Unmarshal(raw, &out); err != nil {
		return DefaultSettings(), fmt.Errorf("parse settings %s: %w", path, err)
	}
	def := DefaultSettings()
	if out.AwayAfterMs <= 0 {
		out.AwayAfterMs = def.AwayAfterMs
	}
	if out.SwitchRecoveryMs <= 0 {
		out.SwitchRecoveryMs = def.SwitchRecoveryMs
	}
	if out.SwitchFlickerMs <= 0 {
		out.SwitchFlickerMs = def.SwitchFlickerMs
	}
	if out.MinEngageMs <= 0 {
		out.MinEngageMs = def.MinEngageMs
	}
	return out, nil
}
