// Package provider defines envelope adapters: anything that can emit a timeline
// envelope for a requested window is a Provider. The Switchboard path
// (switchboard-ctl, which can multiplex Claude and Codex lanes) and the Arachne
// path are both SubprocessProviders. The contract is language-agnostic: any
// source that can produce the envelope plugs in without touching the dashboard.
package provider

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
)

// Params are the request-derived window inputs forwarded to every provider.
type Params struct {
	Day   string
	Since string
	Until string
	Dir   string
}

// Capabilities declares optional features a provider supports (the
// Claude/Anthropic plan-usage gauge, the memory surface). It is a declaration of
// the config contract, not a runtime gate: nothing in the serving path reads it,
// and neither flag changes what gets fetched. Params carries only a window, so a
// provider could not be asked for a capability even if it were read. The UI gates
// on payload presence instead — the plan gauge on plan.available from /api/plan,
// memory on whether /api/memory actually returned figures — which is what
// degrades correctly when a provider advertises a feature its installed binary
// does not have.
type Capabilities struct {
	Plan   bool `json:"plan"`
	Memory bool `json:"memory"`
}

// Provider observes a source and emits a timeline envelope for a window.
type Provider interface {
	ID() string
	Label() string
	Capabilities() Capabilities
	// Fetch returns a timeline-envelope JSON document, or an error (an *ExecError
	// when the underlying process failed, carrying its stderr).
	Fetch(ctx context.Context, p Params) ([]byte, error)
}

// MemoryProvider is the optional memory surface: a provider that can also emit a
// memory document for a window. It is deliberately separate from Provider so a
// source that has no memory data — or a build of one whose binary predates the
// subcommand — remains a complete Provider. /api/memory type-asserts for it and
// treats a provider that does not implement it, or whose subprocess fails,
// identically: that provider contributes nothing and hovers go unenriched.
type MemoryProvider interface {
	FetchMemory(ctx context.Context, p Params) ([]byte, error)
}

// ExecError wraps a provider subprocess failure with its captured stderr so the
// dashboard can surface the real diagnostic.
type ExecError struct {
	Provider string
	Err      error
	Stderr   string
}

func (e *ExecError) Error() string {
	if e.Err == nil {
		return "provider " + e.Provider + " failed"
	}
	return e.Err.Error()
}

func (e *ExecError) Unwrap() error { return e.Err }

// SubprocessProvider runs a configured base command (e.g.
// `switchboard-ctl timeline --json --plan-window`) and appends the standard
// window flags (--dir/--day/--since/--until). The base command must print a
// timeline envelope on stdout.
type SubprocessProvider struct {
	id    string
	label string
	base  []string // full base argv incl. binary and subcommand
	dir   string   // default --dir; overridden by a non-empty Params.Dir
	caps  Capabilities
}

// NewSubprocessProvider builds a SubprocessProvider. base must be non-empty
// (base[0] is the executable, resolved via PATH by exec).
func NewSubprocessProvider(id, label string, base []string, dir string, caps Capabilities) *SubprocessProvider {
	return &SubprocessProvider{id: id, label: label, base: base, dir: dir, caps: caps}
}

func (s *SubprocessProvider) ID() string                 { return s.id }
func (s *SubprocessProvider) Label() string              { return s.label }
func (s *SubprocessProvider) Capabilities() Capabilities { return s.caps }

// argv builds the full command line, appending the window flags. A non-empty
// Params.Dir overrides the provider's configured default dir; empty params are
// omitted so the provider applies its own defaults.
func (s *SubprocessProvider) argv(p Params) []string {
	argv := make([]string, len(s.base))
	copy(argv, s.base)
	return s.appendWindow(argv, p)
}

// memoryArgv builds the memory-surface command from the configured base. Memory
// is a sibling subcommand of the same binary, so everything before the first flag
// is kept verbatim — including a wrapper prefix like `docker exec <ctr> ctl` —
// and only the trailing subcommand and its flags are swapped:
//
//	switchboard-ctl timeline --json --plan-window  ->  switchboard-ctl memory --json
//
// The base's own flags are dropped rather than carried over: --plan-window is a
// timeline flag, and passing it to `memory` would fail the whole call. A base
// that is a bare binary with no subcommand (the test stubs) gets `memory`
// appended instead of substituted.
func (s *SubprocessProvider) memoryArgv(p Params) []string {
	head := s.base
	for i, a := range s.base {
		if i > 0 && strings.HasPrefix(a, "-") {
			head = s.base[:i]
			break
		}
	}
	argv := make([]string, 0, len(head)+9)
	argv = append(argv, head...)
	if len(head) > 1 {
		argv[len(argv)-1] = "memory"
	} else {
		argv = append(argv, "memory")
	}
	argv = append(argv, "--json")
	return s.appendWindow(argv, p)
}

// appendWindow appends the standard window flags. A non-empty Params.Dir
// overrides the provider's configured default dir; empty params are omitted so
// the provider applies its own defaults.
func (s *SubprocessProvider) appendWindow(argv []string, p Params) []string {
	dir := p.Dir
	if dir == "" {
		dir = s.dir
	}
	if dir != "" {
		argv = append(argv, "--dir", dir)
	}
	if p.Day != "" {
		argv = append(argv, "--day", p.Day)
	}
	if p.Since != "" {
		argv = append(argv, "--since", p.Since)
	}
	if p.Until != "" {
		argv = append(argv, "--until", p.Until)
	}
	return argv
}

// Fetch runs the base command with window flags and returns its stdout.
func (s *SubprocessProvider) Fetch(ctx context.Context, p Params) ([]byte, error) {
	return s.run(ctx, s.argv(p))
}

// FetchMemory runs the memory subcommand with window flags and returns its
// stdout. A binary without the subcommand exits non-zero, which the caller reads
// as "this provider contributes no memory" — the same degradation as a provider
// that does not implement MemoryProvider at all.
func (s *SubprocessProvider) FetchMemory(ctx context.Context, p Params) ([]byte, error) {
	return s.run(ctx, s.memoryArgv(p))
}

func (s *SubprocessProvider) run(ctx context.Context, argv []string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, &ExecError{Provider: s.id, Err: err, Stderr: stderr.String()}
	}
	return stdout.Bytes(), nil
}
