package arachne

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// fullCgroupFixture mirrors the file set a real cgroup v2 memory controller
// exposes, with the formats the kernel actually writes.
func fullCgroupFixture() map[string]string {
	return map[string]string{
		"memory.current":      "2147483648\n",
		"memory.peak":         "2952790016\n",
		"memory.max":          "3221225472\n",
		"memory.swap.current": "1048576\n",
		"memory.stat":         "anon 1900000000\nfile 240000000\nkernel 8000000\ninactive_file 209715200\nactive_file 30284800\n",
		"memory.events":       "low 0\nhigh 0\nmax 4\noom 2\noom_kill 1\noom_group_kill 0\n",
	}
}

func writeCgroupFixture(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o444); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
}

func systemdScopeDir(root, id string) string {
	return filepath.Join(root, "system.slice", "docker-"+id+".scope")
}

func TestCgroupReader_shouldReadEveryMemoryFigureFromTheSystemdScope(t *testing.T) {
	root := t.TempDir()
	writeCgroupFixture(t, systemdScopeDir(root, fullID), fullCgroupFixture())

	got, err := NewCgroupReader(root).Read(Container{ID: fullID})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	want := ContainerMemory{
		Current:      2147483648,
		Peak:         2952790016,
		Max:          3221225472,
		Swap:         1048576,
		InactiveFile: 209715200,
		OOMKills:     1,
	}
	if got != want {
		t.Fatalf("memory = %+v, want %+v", got, want)
	}
}

func TestCgroupReader_shouldFallBackToTheCgroupfsLayout(t *testing.T) {
	root := t.TempDir()
	// No system.slice scope: the cgroupfs driver puts the container here instead.
	writeCgroupFixture(t, filepath.Join(root, "docker", fullID), fullCgroupFixture())

	got, err := NewCgroupReader(root).Read(Container{ID: fullID})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got.Current != 2147483648 {
		t.Fatalf("current = %d, want the cgroupfs-layout figure", got.Current)
	}
}

func TestCgroupReader_shouldPreferTheRelocatedDirWhenCgroupParentIsSet(t *testing.T) {
	root := t.TempDir()
	// Both layouts exist; a non-empty CgroupParent must win over the default.
	writeCgroupFixture(t, systemdScopeDir(root, fullID), map[string]string{"memory.current": "111\n"})
	writeCgroupFixture(t, filepath.Join(root, "arachne.slice", "docker-"+fullID+".scope"), map[string]string{"memory.current": "222\n"})

	got, err := NewCgroupReader(root).Read(Container{ID: fullID, CgroupParent: "arachne.slice"})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got.Current != 222 {
		t.Fatalf("current = %d, want 222 from the relocated cgroup", got.Current)
	}
}

func TestCgroupReader_shouldReportGoneWhenTheDirectoryWasNeverThere(t *testing.T) {
	// A container that exited before the first sample: nothing was ever created.
	_, err := NewCgroupReader(t.TempDir()).Read(Container{ID: fullID})
	if !errors.Is(err, ErrCgroupGone) {
		t.Fatalf("err = %v, want ErrCgroupGone", err)
	}
}

func TestCgroupReader_shouldReportGoneWhenTheContainerExitsAfterResolving(t *testing.T) {
	root := t.TempDir()
	dir := systemdScopeDir(root, fullID)
	writeCgroupFixture(t, dir, fullCgroupFixture())
	r := NewCgroupReader(root)

	if _, err := r.Read(Container{ID: fullID}); err != nil {
		t.Fatalf("first Read: %v", err)
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("remove scope: %v", err)
	}

	// The cached path must not survive the container: the kernel removes the
	// directory the instant it exits.
	if _, err := r.Read(Container{ID: fullID}); !errors.Is(err, ErrCgroupGone) {
		t.Fatalf("err after exit = %v, want ErrCgroupGone", err)
	}
	if _, cached := r.dirs[fullID]; cached {
		t.Fatalf("stale cache entry survived the container exit")
	}
}

func TestCgroupReader_shouldReportGoneWithoutAContainerID(t *testing.T) {
	// Inspect failed or predates the id capture — there is no path to derive.
	_, err := NewCgroupReader(t.TempDir()).Read(Container{Name: "arachne-agent-feat-f71"})
	if !errors.Is(err, ErrCgroupGone) {
		t.Fatalf("err = %v, want ErrCgroupGone", err)
	}
}

func TestCgroupReader_shouldReadAnUnlimitedMaxAsZero(t *testing.T) {
	root := t.TempDir()
	writeCgroupFixture(t, systemdScopeDir(root, fullID), map[string]string{
		"memory.current": "1024\n",
		"memory.max":     "max\n",
	})

	got, err := NewCgroupReader(root).Read(Container{ID: fullID})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got.Max != 0 {
		t.Fatalf("max = %d, want 0 for an uncapped container", got.Max)
	}
}

func TestCgroupReader_shouldTolerateMissingOptionalFiles(t *testing.T) {
	root := t.TempDir()
	// An older kernel exposes memory.current but no memory.peak; the reading
	// should still come back rather than failing wholesale.
	writeCgroupFixture(t, systemdScopeDir(root, fullID), map[string]string{"memory.current": "4096\n"})

	got, err := NewCgroupReader(root).Read(Container{ID: fullID})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got.Current != 4096 {
		t.Fatalf("current = %d, want 4096", got.Current)
	}
	if got != (ContainerMemory{Current: 4096}) {
		t.Fatalf("absent files should read as zero, got %+v", got)
	}
}

func TestCgroupReader_shouldForgetACachedDirectory(t *testing.T) {
	root := t.TempDir()
	writeCgroupFixture(t, systemdScopeDir(root, fullID), fullCgroupFixture())
	r := NewCgroupReader(root)

	if _, err := r.Read(Container{ID: fullID}); err != nil {
		t.Fatalf("Read: %v", err)
	}
	r.Forget(fullID)
	if _, cached := r.dirs[fullID]; cached {
		t.Fatalf("Forget left the cache entry behind")
	}
	if _, err := r.Read(Container{ID: fullID}); err != nil {
		t.Fatalf("Read after Forget should re-resolve: %v", err)
	}
}

func TestNewRecorder_shouldDefaultTheCgroupRootToTheUnifiedMount(t *testing.T) {
	if got := NewRecorder(Config{}).cgroups.root; got != DefaultCgroupRoot {
		t.Fatalf("default cgroup root = %q, want %q", got, DefaultCgroupRoot)
	}
	if got := NewRecorder(Config{CgroupRoot: "/fixture"}).cgroups.root; got != "/fixture" {
		t.Fatalf("configured cgroup root = %q, want /fixture", got)
	}
}
