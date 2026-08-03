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

func TestClient_ListRunningNames_shouldFilterToArachnePrefix(t *testing.T) {
	r := fakeRunner{outputs: map[string][]byte{
		"ps": []byte("arachne-agent-feat-f71\narachne-agent\nsomething-else\n\n"),
	}}
	c := &Client{Runner: r}
	names, err := c.ListRunningNames(context.Background())
	if err != nil {
		t.Fatalf("ListRunningNames: %v", err)
	}
	if len(names) != 2 {
		t.Fatalf("names = %v, want the slugged + bare arachne-agent (something-else filtered)", names)
	}
	set := map[string]bool{}
	for _, n := range names {
		set[n] = true
	}
	if !set["arachne-agent-feat-f71"] || !set["arachne-agent"] {
		t.Fatalf("expected both arachne containers, got %v", names)
	}
}

func TestClient_Inspect_shouldParseEnvStatusAndStartedAt(t *testing.T) {
	body := `[{"Id":"` + fullID + `","Name":"/arachne-agent-feat-f71","State":{"Status":"running","StartedAt":"2026-07-22T02:00:00Z"},"Config":{"Env":["PATH=/usr/bin","AGENT_MODEL=opus","ARACHNE_TASK_ID=F71.1","ARACHNE_PHASE=F71","WORKSPACE_PATH=/ws/feat/f71","REPO_ROOT=/home/x/Arachne","ARACHNE_BRIEF=/ws/brief.md"]},"HostConfig":{"CgroupParent":"","Memory":3221225472,"MemorySwap":5368709120}}]`
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

// fullID is the 64-char form docker inspect reports. `docker ps` truncates to 12
// chars, which does not match the cgroup scope dirname — hence inspect-only.
const fullID = "3f8a1c5e9b2d47a06e1f8c3b5d9a72e4f60c18b3a5d7e92f4c6b8a0d1e3f5c79"

func TestClient_Inspect_shouldCaptureFullIDAndHostConfigLimits(t *testing.T) {
	body := `[{"Id":"` + fullID + `","Name":"/arachne-agent-feat-f71","State":{"Status":"running"},"Config":{"Env":[]},"HostConfig":{"CgroupParent":"custom.slice","Memory":6442450944,"MemorySwap":8589934592}}]`
	c := &Client{Runner: fakeRunner{outputs: map[string][]byte{"inspect": []byte(body)}}}
	got, err := c.Inspect(context.Background(), "arachne-agent-feat-f71")
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	if got.ID != fullID {
		t.Fatalf("ID = %q, want the full 64-char id %q", got.ID, fullID)
	}
	if len(got.ID) != 64 {
		t.Fatalf("ID length = %d, want 64 (short form would not match the scope dirname)", len(got.ID))
	}
	if got.CgroupParent != "custom.slice" {
		t.Fatalf("CgroupParent = %q, want custom.slice", got.CgroupParent)
	}
	if got.MemoryLimit != 6442450944 || got.MemorySwap != 8589934592 {
		t.Fatalf("limits wrong: %+v", got)
	}
}

func TestClient_Inspect_shouldLeaveLimitsZeroWhenHostConfigAbsent(t *testing.T) {
	body := `[{"Id":"` + fullID + `","Name":"/arachne-agent","State":{"Status":"running"},"Config":{"Env":[]}}]`
	c := &Client{Runner: fakeRunner{outputs: map[string][]byte{"inspect": []byte(body)}}}
	got, err := c.Inspect(context.Background(), "arachne-agent")
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	if got.CgroupParent != "" || got.MemoryLimit != 0 || got.MemorySwap != 0 {
		t.Fatalf("expected zero limits without HostConfig, got %+v", got)
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
