package provider

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeStub(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "stub")
	if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	return p
}

func TestSubprocessProvider_argv_shouldAppendWindowFlagsToBase(t *testing.T) {
	base := []string{"switchboard-ctl", "timeline", "--json", "--plan-window"}
	tests := []struct {
		name string
		dir  string
		in   Params
		want []string
	}{
		{
			name: "should emit base unchanged when no params set",
			want: append([]string{}, base...),
		},
		{
			name: "should forward day and query dir when set",
			in:   Params{Day: "2026-06-20", Dir: "/var/hist"},
			want: append(append([]string{}, base...), "--dir", "/var/hist", "--day", "2026-06-20"),
		},
		{
			name: "should use provider default dir when query dir absent",
			dir:  "/default/hist",
			in:   Params{Day: "2026-06-20"},
			want: append(append([]string{}, base...), "--dir", "/default/hist", "--day", "2026-06-20"),
		},
		{
			name: "should let query dir override provider default",
			dir:  "/default/hist",
			in:   Params{Dir: "/override"},
			want: append(append([]string{}, base...), "--dir", "/override"),
		},
		{
			name: "should forward since and until",
			in:   Params{Since: "2026-06-01", Until: "2026-06-30"},
			want: append(append([]string{}, base...), "--since", "2026-06-01", "--until", "2026-06-30"),
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := NewSubprocessProvider("claude", "Claude", base, tc.dir, Capabilities{Plan: true})
			got := s.argv(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("argv = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSubprocessProvider_memoryArgv_shouldSwapTheSubcommandAndDropTimelineFlags(t *testing.T) {
	tests := []struct {
		name string
		base []string
		dir  string
		in   Params
		want []string
	}{
		{
			name: "should replace the subcommand and drop the base flags",
			base: []string{"switchboard-ctl", "timeline", "--json", "--plan-window"},
			want: []string{"switchboard-ctl", "memory", "--json"},
		},
		{
			name: "should append memory to a base with no subcommand",
			base: []string{"/tmp/stub-ctl"},
			want: []string{"/tmp/stub-ctl", "memory", "--json"},
		},
		{
			name: "should keep a wrapper prefix and swap only the subcommand",
			base: []string{"docker", "exec", "ctr", "arachne-ctl", "timeline", "--json"},
			want: []string{"docker", "exec", "ctr", "arachne-ctl", "memory", "--json"},
		},
		{
			name: "should forward the window flags",
			base: []string{"switchboard-ctl", "timeline", "--json"},
			dir:  "/default/hist",
			in:   Params{Day: "2026-06-26", Since: "2026-06-01", Until: "2026-06-30"},
			want: []string{"switchboard-ctl", "memory", "--json", "--dir", "/default/hist", "--day", "2026-06-26", "--since", "2026-06-01", "--until", "2026-06-30"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := NewSubprocessProvider("claude", "Claude", tc.base, tc.dir, Capabilities{Memory: true})
			got := s.memoryArgv(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("memoryArgv = %v, want %v", got, tc.want)
			}
			// The base must survive derivation — the same provider still serves
			// timelines after a memory fetch.
			if !reflect.DeepEqual(s.argv(Params{})[:len(tc.base)], tc.base) {
				t.Fatalf("memoryArgv mutated the shared base: %v, want %v", s.base, tc.base)
			}
		})
	}
}

func TestSubprocessProvider_FetchMemory_shouldReturnStdoutOfTheMemorySubcommand(t *testing.T) {
	stub := writeStub(t, "#!/bin/sh\nprintf '%s' \"$1\"\n")
	s := NewSubprocessProvider("p", "P", []string{stub, "timeline", "--json"}, "", Capabilities{Memory: true})
	out, err := s.FetchMemory(context.Background(), Params{})
	if err != nil {
		t.Fatalf("FetchMemory error: %v", err)
	}
	if string(out) != "memory" {
		t.Fatalf("subcommand = %q, want memory", out)
	}
}

func TestSubprocessProvider_FetchMemory_shouldErrorWhenTheBinaryLacksTheSubcommand(t *testing.T) {
	stub := writeStub(t, "#!/bin/sh\necho 'unknown subcommand \"memory\"' >&2\nexit 1\n")
	s := NewSubprocessProvider("claude", "Claude", []string{stub, "timeline", "--json"}, "", Capabilities{})
	if _, err := s.FetchMemory(context.Background(), Params{}); err == nil {
		t.Fatalf("expected an error the caller can degrade on")
	}
}

func TestSubprocessProvider_Fetch_shouldReturnStdoutOnSuccess(t *testing.T) {
	stub := writeStub(t, "#!/bin/sh\nprintf '%s' '{\"window\":\"x\"}'\n")
	s := NewSubprocessProvider("p", "P", []string{stub, "timeline", "--json"}, "", Capabilities{})
	out, err := s.Fetch(context.Background(), Params{})
	if err != nil {
		t.Fatalf("Fetch error: %v", err)
	}
	if string(out) != `{"window":"x"}` {
		t.Fatalf("stdout = %q", out)
	}
}

func TestSubprocessProvider_Fetch_shouldReturnExecErrorWithStderrOnFailure(t *testing.T) {
	stub := writeStub(t, "#!/bin/sh\necho 'boom: bad flag' >&2\nexit 4\n")
	s := NewSubprocessProvider("arachne", "Arachne", []string{stub, "timeline", "--json"}, "", Capabilities{})
	_, err := s.Fetch(context.Background(), Params{})
	if err == nil {
		t.Fatalf("expected error")
	}
	var ee *ExecError
	if !errors.As(err, &ee) {
		t.Fatalf("expected *ExecError, got %T", err)
	}
	if ee.Provider != "arachne" {
		t.Fatalf("ExecError.Provider = %q, want arachne", ee.Provider)
	}
	if !strings.Contains(ee.Stderr, "boom: bad flag") {
		t.Fatalf("stderr not captured: %q", ee.Stderr)
	}
}
