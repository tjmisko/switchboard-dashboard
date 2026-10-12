package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBillingExpectationsAcceptDeclarationAndRejectInvalidRoute(t *testing.T) {
	path := filepath.Join(t.TempDir(), "billing.json")
	if err := os.WriteFile(path, []byte(`{"claude":{"expected_route":"subscription"},"pi":{"expected_route":"gateway"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := readBillingExpectations(path)
	if err != nil || got["claude"].ExpectedRoute != "subscription" || got["pi"].ExpectedRoute != "gateway" {
		t.Fatalf("expectations=%+v error=%v", got, err)
	}
	if err := os.WriteFile(path, []byte(`{"claude":{"expected_route":"free"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readBillingExpectations(path); err == nil {
		t.Fatal("invalid route was accepted")
	}
}
