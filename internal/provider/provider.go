// Package provider defines the Switchboard data-provider adapter: anything that
// can emit a timeline envelope for a requested window is a Provider. The Claude
// path (switchboard-ctl) and the Arachne path (arachne-ctl) are both realized as
// SubprocessProviders — external binaries that print an envelope on stdout — so
// the contract is language-agnostic: any source that can produce the envelope
// plugs in without touching the dashboard.
package provider

import (
	"bytes"
	"context"
	"os/exec"
)

// Params are the request-derived window inputs forwarded to every provider.
type Params struct {
	Day   string
	Since string
	Until string
	Dir   string
}

// Capabilities declares optional features a provider supports so the UI can gate
// provider-specific chrome (e.g. the Claude/Anthropic plan-usage gauge).
type Capabilities struct {
	Plan bool `json:"plan"`
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
	argv := s.argv(p)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, &ExecError{Provider: s.id, Err: err, Stderr: stderr.String()}
	}
	return stdout.Bytes(), nil
}
