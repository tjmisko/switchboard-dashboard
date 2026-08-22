package provider

import (
	"encoding/json"
	"fmt"
	"os"
)

// Config is the providers file: an ordered list of provider adapters the
// dashboard runs and merges. Order is preserved (it seeds lane order in the
// merged view).
type Config struct {
	Providers []ProviderConfig `json:"providers"`
}

// ProviderConfig describes one SubprocessProvider.
//
//	{
//	  "providers": [
//	    {"id":"claude","label":"Switchboard (Claude + Codex)",
//	     "exec":["switchboard-ctl","timeline","--json","--plan-window"],
//	     "capabilities":{"plan":true,"memory":true}},
//	    {"id":"arachne","label":"Arachne",
//	     "exec":["arachne-ctl","timeline","--json"],
//	     "dir":"/home/you/.arachne-switchboard/history",
//	     "capabilities":{"plan":false,"memory":true}}
//	  ]
//	}
//
// exec is the full base command that prints a timeline envelope on stdout; the
// dashboard appends --dir/--day/--since/--until. dir is the default --dir value.
// capabilities is declarative only (see Capabilities); the dashboard discovers
// what a provider can actually do by calling it.
type ProviderConfig struct {
	ID           string       `json:"id"`
	Label        string       `json:"label"`
	Exec         []string     `json:"exec"`
	Dir          string       `json:"dir"`
	Capabilities Capabilities `json:"capabilities"`
}

// LoadConfig reads and validates a providers file.
func LoadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse providers config %s: %w", path, err)
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) validate() error {
	if len(c.Providers) == 0 {
		return fmt.Errorf("providers config lists no providers")
	}
	seen := map[string]bool{}
	for i, pc := range c.Providers {
		if pc.ID == "" {
			return fmt.Errorf("provider #%d: missing id", i)
		}
		if seen[pc.ID] {
			return fmt.Errorf("duplicate provider id %q", pc.ID)
		}
		seen[pc.ID] = true
		if len(pc.Exec) == 0 {
			return fmt.Errorf("provider %q: exec is empty", pc.ID)
		}
	}
	return nil
}

// Build constructs the providers described by the config, in order.
func (c *Config) Build() ([]Provider, error) {
	if err := c.validate(); err != nil {
		return nil, err
	}
	out := make([]Provider, 0, len(c.Providers))
	for _, pc := range c.Providers {
		label := pc.Label
		if label == "" {
			label = pc.ID
		}
		out = append(out, NewSubprocessProvider(pc.ID, label, pc.Exec, pc.Dir, pc.Capabilities))
	}
	return out, nil
}
