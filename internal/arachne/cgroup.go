// Host-side cgroup v2 memory for Arachne's session containers.
//
// The kernel already tracks everything we want, in world-readable (0444) files
// under the unified cgroup mount, so a reading costs no root, no daemon call and
// no `docker stats` subprocess. memory.peak matters most: it is a kernel-
// maintained high-water mark, which yields an exact per-container peak with no
// sampling cadence at all, and memory.events reports whether the container's
// memory cage actually killed something — a fact that otherwise surfaces only as
// an unexplained session_end.

package arachne

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// DefaultCgroupRoot is the cgroup v2 unified mount point.
const DefaultCgroupRoot = "/sys/fs/cgroup"

// ErrCgroupGone reports that a container's cgroup directory is not there: either
// the container exited (the directory vanishes the instant it does) or no
// candidate layout matched. Sampling runs on a timer against containers that
// disappear without warning, so this is the ordinary end of a session rather
// than a failure, and is meant to be skipped silently.
var ErrCgroupGone = errors.New("container cgroup not found")

// ContainerMemory is one host-side reading of a container's memory controller,
// in bytes. The figures are raw kernel values; deriving a `docker stats`-
// equivalent working set (Current minus InactiveFile) is left to the compiler.
type ContainerMemory struct {
	Current      int64 // memory.current — includes page cache
	Peak         int64 // memory.peak — high-water mark since the container started
	Max          int64 // memory.max — the cage; 0 when unlimited
	Swap         int64 // memory.swap.current
	InactiveFile int64 // memory.stat inactive_file — the reclaimable part of the page cache
	OOMKills     int64 // memory.events oom_kill — how often the cage killed a process
}

// CgroupReader reads container memory from the host's cgroup v2 tree.
//
// The directory layout depends on docker's cgroup driver (systemd names a scope,
// cgroupfs uses a plain directory) and on any --cgroup-parent, so it is resolved
// from an ordered candidate list on the first read and cached per container id.
// Readings are host-side only: containers run with cgroupns=private, so a
// container's own /proc/self/cgroup reports "/" and tells us nothing.
//
// Not safe for concurrent use — the recorder samples from its single tick loop.
type CgroupReader struct {
	root string
	dirs map[string]string // container id -> resolved cgroup directory
}

// NewCgroupReader returns a reader rooted at the cgroup v2 mount. An empty root
// means DefaultCgroupRoot; tests point it at a fixture tree.
func NewCgroupReader(root string) *CgroupReader {
	if root == "" {
		root = DefaultCgroupRoot
	}
	return &CgroupReader{root: root, dirs: map[string]string{}}
}

// Read returns one memory reading for a container, or ErrCgroupGone once the
// container has exited. Optional files (peak, max, swap, stat, events) that are
// missing contribute zero rather than failing the read, so a kernel without
// memory.peak still yields a usable current figure.
func (r *CgroupReader) Read(c Container) (ContainerMemory, error) {
	dir, err := r.resolve(c)
	if err != nil {
		return ContainerMemory{}, err
	}
	current, err := readCgroupInt(filepath.Join(dir, "memory.current"))
	if err != nil {
		if os.IsNotExist(err) {
			delete(r.dirs, c.ID) // it exited between the resolve and the read
			return ContainerMemory{}, ErrCgroupGone
		}
		return ContainerMemory{}, err
	}
	m := ContainerMemory{Current: current}
	m.Peak, _ = readCgroupInt(filepath.Join(dir, "memory.peak"))
	m.Max, _ = readCgroupInt(filepath.Join(dir, "memory.max"))
	m.Swap, _ = readCgroupInt(filepath.Join(dir, "memory.swap.current"))
	m.InactiveFile = readCgroupKey(filepath.Join(dir, "memory.stat"), "inactive_file")
	m.OOMKills = readCgroupKey(filepath.Join(dir, "memory.events"), "oom_kill")
	return m, nil
}

// Forget drops a container's cached directory, so the cache does not grow for
// the lifetime of the daemon as sessions come and go.
func (r *CgroupReader) Forget(id string) { delete(r.dirs, id) }

// resolve returns the container's cgroup directory, probing the candidates on
// first sight and caching the winner. A cached directory that has vanished means
// the container exited, so the entry is dropped rather than re-probed.
func (r *CgroupReader) resolve(c Container) (string, error) {
	if c.ID == "" || strings.ContainsRune(c.ID, filepath.Separator) {
		return "", ErrCgroupGone // no usable id means no path to derive
	}
	if dir, ok := r.dirs[c.ID]; ok {
		if hasMemoryController(dir) {
			return dir, nil
		}
		delete(r.dirs, c.ID)
		return "", ErrCgroupGone
	}
	for _, dir := range r.candidates(c) {
		if !hasMemoryController(dir) {
			continue
		}
		r.dirs[c.ID] = dir
		return dir, nil
	}
	return "", ErrCgroupGone
}

// candidates lists the directories a container's cgroup could live in, most
// likely first. The scope name uses the full 64-char id — the 12-char form
// `docker ps` prints does not match it.
func (r *CgroupReader) candidates(c Container) []string {
	scope := "docker-" + c.ID + ".scope"
	if parent := strings.Trim(c.CgroupParent, "/"); parent != "" {
		return []string{
			filepath.Join(r.root, parent, scope), // systemd driver, relocated
			filepath.Join(r.root, parent, c.ID),  // cgroupfs driver, relocated
		}
	}
	return []string{
		filepath.Join(r.root, "system.slice", scope), // systemd driver (docker's default)
		filepath.Join(r.root, "docker", c.ID),        // cgroupfs driver
	}
}

// hasMemoryController reports whether a directory is a live cgroup with the
// memory controller enabled. memory.current is the file every reading needs, so
// probing it tests existence and usability at once.
func hasMemoryController(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "memory.current"))
	return err == nil
}

// readCgroupInt reads a single-value cgroup file. The literal "max" — how the
// kernel writes an absent limit — reads as 0, so callers treat "unlimited" and
// "no figure" alike without branching.
func readCgroupInt(path string) (int64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	s := strings.TrimSpace(string(b))
	if s == "" || s == "max" {
		return 0, nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", path, err)
	}
	return v, nil
}

// readCgroupKey pulls one "<key> <value>" line out of a flat cgroup file
// (memory.stat, memory.events). A missing file, key, or value reads as 0.
func readCgroupKey(path, key string) int64 {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		name, value, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok || name != key {
			continue
		}
		v, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil {
			return 0
		}
		return v
	}
	return 0
}
