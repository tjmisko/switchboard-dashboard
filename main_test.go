package main

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestDefaultPortAndServiceUnitStayAligned(t *testing.T) {
	if defaultPort != 8780 {
		t.Fatalf("defaultPort = %d, want 8780", defaultPort)
	}

	unit, err := os.ReadFile("systemd/switchboard-dashboard.service")
	if err != nil {
		t.Fatalf("read service unit: %v", err)
	}
	text := string(unit)
	if want := fmt.Sprintf("http://localhost:%d", defaultPort); !strings.Contains(text, want) {
		t.Errorf("service description does not advertise %s", want)
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "ExecStart=") && strings.Contains(line, " -port ") {
			t.Errorf("service unit overrides the binary's default port: %s", line)
		}
	}
}
