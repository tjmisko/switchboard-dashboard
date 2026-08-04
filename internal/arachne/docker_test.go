package arachne

import (
	"context"
	"fmt"
	"testing"
)

type fakeRunner struct {
	outputs map[string][]byte // keyed by subcommand (args[0])
	err     error
}

func (f fakeRunner) Run(ctx context.Context, args ...string) ([]byte, error) {
	if f.err != nil {
		return nil, f.err
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("no args")
	}
	if b, ok := f.outputs[args[0]]; ok {
		return b, nil
	}
	return nil, fmt.Errorf("no canned output for %v", args)
}

func TestClient_ListRunning_shouldFilterToArachnePrefixAndCarryContainerIDs(t *testing.T) {
	r := fakeRunner{outputs: map[string][]byte{
		"ps": []byte("abc123\tarachne-agent-feat-f71\ndef456\tarachne-agent\n789xyz\tsomething-else\n\n"),
	}}
	c := &Client{Runner: r}
	running, err := c.ListRunning(context.Background())
	if err != nil {
		t.Fatalf("ListRunning: %v", err)
	}
	if len(running) != 2 {
		t.Fatalf("running = %v, want the slugged + bare arachne-agent (something-else filtered)", running)
	}
	byName := map[string]string{}
	for _, rc := range running {
		byName[rc.Name] = rc.ID
	}
	if byName["arachne-agent-feat-f71"] != "abc123" || byName["arachne-agent"] != "def456" {
		t.Fatalf("expected both arachne containers with their ids, got %v", byName)
	}
}

func TestClient_Inspect_shouldParseEnvStatusAndStartedAt(t *testing.T) {
	body := `[{"Name":"/arachne-agent-feat-f71","State":{"Status":"running","StartedAt":"2026-07-22T02:00:00Z"},"Config":{"Env":["PATH=/usr/bin","AGENT_MODEL=opus","ARACHNE_TASK_ID=F71.1","ARACHNE_PHASE=F71","WORKSPACE_PATH=/ws/feat/f71","REPO_ROOT=/home/x/Arachne","ARACHNE_BRIEF=/ws/brief.md"]}}]`
	r := fakeRunner{outputs: map[string][]byte{"inspect": []byte(body)}}
	c := &Client{Runner: r}
	got, err := c.Inspect(context.Background(), "arachne-agent-feat-f71")
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	if got.Slug != "feat-f71" || got.Agent != "opus" || got.TaskID != "F71.1" || got.Phase != "F71" {
		t.Fatalf("metadata wrong: %+v", got)
	}
	if got.Workspace != "/ws/feat/f71" || got.RepoRoot != "/home/x/Arachne" || got.Brief != "/ws/brief.md" {
		t.Fatalf("paths wrong: %+v", got)
	}
	if got.Status != "running" || got.StartedAt != "2026-07-22T02:00:00Z" {
		t.Fatalf("status/start wrong: %+v", got)
	}
	if got.LogPath() != "/ws/feat/f71/.arachne-agent.log" {
		t.Fatalf("log path = %q", got.LogPath())
	}
}

func TestSlugOf_shouldStripPrefixAndKeepBareName(t *testing.T) {
	if got := SlugOf("arachne-agent-feat-f71"); got != "feat-f71" {
		t.Fatalf("SlugOf slugged = %q, want feat-f71", got)
	}
	if got := SlugOf("arachne-agent"); got != "arachne-agent" {
		t.Fatalf("SlugOf bare = %q, want arachne-agent", got)
	}
}
