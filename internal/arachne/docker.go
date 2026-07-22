package arachne

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

// NamePrefix is the container-name convention that identifies an Arachne agent
// session. Arachne sets no docker labels, so the name prefix is the only
// reliable selector (matching every internal tool: pump, monitor, watchdogs).
const NamePrefix = "arachne-agent"

// Runner executes a docker subcommand and returns its stdout. It is an interface
// so tests can inject a fake docker without a daemon.
type Runner interface {
	Run(ctx context.Context, args ...string) ([]byte, error)
}

// ExecRunner runs the real docker CLI (Bin defaults to "docker").
type ExecRunner struct{ Bin string }

func (r ExecRunner) Run(ctx context.Context, args ...string) ([]byte, error) {
	bin := r.Bin
	if bin == "" {
		bin = "docker"
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("docker %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	return out.Bytes(), nil
}

// Client enumerates and inspects Arachne session containers.
type Client struct{ Runner Runner }

// NewClient returns a Client over the real docker CLI.
func NewClient() *Client { return &Client{Runner: ExecRunner{}} }

// Container is the metadata an adapter extracts per session container.
type Container struct {
	Name      string
	Slug      string // session identity: name minus the "arachne-agent-" prefix
	Status    string // .State.Status (running/exited/…)
	StartedAt string // .State.StartedAt (RFC3339) — accurate session start
	Agent     string // AGENT_MODEL
	TaskID    string // ARACHNE_TASK_ID
	Phase     string // ARACHNE_PHASE
	Brief     string // ARACHNE_BRIEF
	Workspace string // WORKSPACE_PATH (worktree)
	RepoRoot  string // REPO_ROOT
}

// LogPath is the container's stream-json log inside its worktree.
func (c Container) LogPath() string {
	if c.Workspace == "" {
		return ""
	}
	return filepath.Join(c.Workspace, ".arachne-agent.log")
}

// SlugOf maps a container name to a stable session slug: the branch slug for
// "arachne-agent-<slug>", or the bare name for the in-place "arachne-agent".
func SlugOf(name string) string {
	if s := strings.TrimPrefix(name, NamePrefix+"-"); s != name {
		return s
	}
	return name
}

// ListRunningNames returns the names of running Arachne session containers. The
// docker name filter is a substring match, so results are re-checked against the
// NamePrefix to avoid matching an unrelated container that merely contains it.
func (c *Client) ListRunningNames(ctx context.Context) ([]string, error) {
	out, err := c.Runner.Run(ctx, "ps", "--filter", "name="+NamePrefix, "--format", "{{.Names}}")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, line := range strings.Split(string(out), "\n") {
		name := strings.TrimSpace(line)
		if name == "" {
			continue
		}
		if name == NamePrefix || strings.HasPrefix(name, NamePrefix+"-") {
			names = append(names, name)
		}
	}
	return names, nil
}

type inspectResult struct {
	Name  string `json:"Name"`
	State struct {
		Status    string `json:"Status"`
		StartedAt string `json:"StartedAt"`
	} `json:"State"`
	Config struct {
		Env []string `json:"Env"`
	} `json:"Config"`
}

// Inspect returns the metadata for one container.
func (c *Client) Inspect(ctx context.Context, name string) (Container, error) {
	out, err := c.Runner.Run(ctx, "inspect", name)
	if err != nil {
		return Container{}, err
	}
	var arr []inspectResult
	if err := json.Unmarshal(out, &arr); err != nil {
		return Container{}, fmt.Errorf("parse docker inspect %s: %w", name, err)
	}
	if len(arr) == 0 {
		return Container{}, fmt.Errorf("docker inspect %s returned no objects", name)
	}
	r := arr[0]
	env := parseEnv(r.Config.Env)
	return Container{
		Name:      name,
		Slug:      SlugOf(name),
		Status:    r.State.Status,
		StartedAt: r.State.StartedAt,
		Agent:     env["AGENT_MODEL"],
		TaskID:    env["ARACHNE_TASK_ID"],
		Phase:     env["ARACHNE_PHASE"],
		Brief:     env["ARACHNE_BRIEF"],
		Workspace: env["WORKSPACE_PATH"],
		RepoRoot:  env["REPO_ROOT"],
	}, nil
}

func parseEnv(env []string) map[string]string {
	out := make(map[string]string, len(env))
	for _, kv := range env {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			out[kv[:i]] = kv[i+1:]
		}
	}
	return out
}
