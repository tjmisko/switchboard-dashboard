package main

import (
	"sync"
	"time"
)

// dayCache memoizes /api/timeline envelopes for CLOSED days.
//
// Every timeline request costs a provider subprocess spawn plus a history scan
// — measured at 1.4-2.0s, and flat in payload size (a 35KB day is no faster
// than a 265KB one). That fixed cost is the entire perceived latency of a day
// switch, so the only way to remove it (rather than animate over it) is to not
// pay it twice for the same window.
//
// Only closed days are cached. Today is always live: it is what the 3s poll
// watches, and a cached today would freeze the dashboard's whole point.
//
// Entries carry a TTL despite a past day being nominally immutable. The
// envelope for day D includes sessions that OVERLAP D, so a session started
// before midnight and still running now keeps extending its lane in yesterday's
// response. The TTL bounds how stale that edge case can get; for the common
// case — stepping back through finished history — it never expires in practice
// because the work is done in one sitting.
type dayCache struct {
	mu      sync.Mutex
	entries map[string]dayCacheEntry
	ttl     time.Duration
	max     int
	// now and today are injected for tests; nil means time.Now / local date.
	nowFn func() time.Time
}

type dayCacheEntry struct {
	body     []byte
	storedAt time.Time
}

// dayCacheTTL bounds staleness for a closed day whose sessions may still be
// running (see the type comment). Long enough that stepping back and forth
// through history never re-pays the subprocess cost.
const dayCacheTTL = 10 * time.Minute

// dayCacheMax caps retained days. Each envelope is O(100KB), so this is a few
// tens of MB worst case — bounded, and far cheaper than the spawns it avoids.
const dayCacheMax = 64

func newDayCache() *dayCache {
	return &dayCache{entries: make(map[string]dayCacheEntry), ttl: dayCacheTTL, max: dayCacheMax}
}

func (c *dayCache) now() time.Time {
	if c.nowFn != nil {
		return c.nowFn()
	}
	return time.Now()
}

// cacheable reports whether a request may be served from, or stored in, the
// cache. Only a bare `?day=` in the past qualifies: since/until/dir change the
// window without changing the key, so a request carrying any of them is passed
// through uncached rather than risking a wrong hit.
func (c *dayCache) cacheable(day, since, until, dir string) bool {
	if day == "" || since != "" || until != "" || dir != "" {
		return false
	}
	return day < c.now().Format("2006-01-02")
}

// get returns a cached body for a closed day, if one is live.
func (c *dayCache) get(day string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[day]
	if !ok {
		return nil, false
	}
	if c.now().Sub(e.storedAt) > c.ttl {
		delete(c.entries, day)
		return nil, false
	}
	return e.body, true
}

// put stores a body for a closed day, evicting the oldest entry when full.
func (c *dayCache) put(day string, body []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= c.max {
		oldestDay, oldestAt := "", time.Time{}
		for d, e := range c.entries {
			if oldestDay == "" || e.storedAt.Before(oldestAt) {
				oldestDay, oldestAt = d, e.storedAt
			}
		}
		delete(c.entries, oldestDay)
	}
	c.entries[day] = dayCacheEntry{body: body, storedAt: c.now()}
}
