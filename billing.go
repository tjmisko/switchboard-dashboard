package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
)

type billingExpectation struct {
	ExpectedRoute string `json:"expected_route,omitempty"`
}

func defaultBillingPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "switchboard", "billing.json")
}

func readBillingExpectations(path string) (map[string]billingExpectation, error) {
	out := map[string]billingExpectation{}
	if path == "" {
		return out, nil
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read billing settings: %w", err)
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("parse billing settings: %w", err)
	}
	for agent, value := range out {
		switch value.ExpectedRoute {
		case "", "subscription", "chatgpt_subscription", "api", "gateway", "cloud":
		default:
			return nil, fmt.Errorf("invalid expected_route for %s", agent)
		}
	}
	return out, nil
}

func (s *Server) handleBilling(w http.ResponseWriter, _ *http.Request) {
	expectations, err := readBillingExpectations(defaultBillingPath())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(expectations)
}
