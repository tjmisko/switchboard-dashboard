package main

import (
	"testing"
	"time"
)

func fixedNow(t *testing.T, iso string) func() time.Time {
	t.Helper()
	parsed, err := time.ParseInLocation("2006-01-02T15:04:05", iso, time.Local)
	if err != nil {
		t.Fatalf("bad fixture time %q: %v", iso, err)
	}
	return func() time.Time { return parsed }
}

func newTestCache(t *testing.T, iso string) *dayCache {
	t.Helper()
	c := newDayCache()
	c.nowFn = fixedNow(t, iso)
	return c
}

func TestDayCache_cacheable_shouldAcceptABareDayInThePast(t *testing.T) {
	c := newTestCache(t, "2026-08-06T09:00:00")
	if !c.cacheable("2026-08-05", "", "", "") {
		t.Fatal("a closed day with no other window flags should be cacheable")
	}
}

func TestDayCache_cacheable_shouldRejectTodaySoTheLivePollIsNeverFrozen(t *testing.T) {
	c := newTestCache(t, "2026-08-06T09:00:00")
	if c.cacheable("2026-08-06", "", "", "") {
		t.Fatal("today must never be cached — it is what the live poll watches")
	}
}

func TestDayCache_cacheable_shouldRejectAFutureDay(t *testing.T) {
	c := newTestCache(t, "2026-08-06T09:00:00")
	if c.cacheable("2026-08-07", "", "", "") {
		t.Fatal("a future day is not closed and must not be cached")
	}
}

func TestDayCache_cacheable_shouldRejectAnEmptyDay(t *testing.T) {
	c := newTestCache(t, "2026-08-06T09:00:00")
	if c.cacheable("", "", "", "") {
		t.Fatal("a request with no day is the live window and must not be cached")
	}
}

// since/until/dir change the window without changing the key, so a request
// carrying any of them must bypass the cache rather than risk a wrong hit.
func TestDayCache_cacheable_shouldRejectWindowFlagsThatAreNotPartOfTheKey(t *testing.T) {
	c := newTestCache(t, "2026-08-06T09:00:00")
	cases := []struct {
		name                string
		since, until, dirIn string
	}{
		{"since", "2026-08-05T00:00:00Z", "", ""},
		{"until", "", "2026-08-05T23:59:59Z", ""},
		{"dir", "", "", "/some/other/history"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if c.cacheable("2026-08-05", tc.since, tc.until, tc.dirIn) {
				t.Fatalf("%s is not part of the cache key, so the request must bypass the cache", tc.name)
			}
		})
	}
}

func TestDayCache_get_shouldReturnAStoredBodyForAClosedDay(t *testing.T) {
	c := newTestCache(t, "2026-08-06T09:00:00")
	c.put("2026-08-05", []byte(`{"window":"2026-08-05"}`))
	got, ok := c.get("2026-08-05")
	if !ok {
		t.Fatal("a freshly stored day should hit")
	}
	if string(got) != `{"window":"2026-08-05"}` {
		t.Fatalf("body round-tripped wrong: %s", got)
	}
}

func TestDayCache_get_shouldMissForADayNeverStored(t *testing.T) {
	c := newTestCache(t, "2026-08-06T09:00:00")
	if _, ok := c.get("2026-08-04"); ok {
		t.Fatal("an unstored day should miss")
	}
}

// A day's envelope includes sessions that OVERLAP it, so one still running past
// midnight keeps extending yesterday's lanes. The TTL is what bounds that.
func TestDayCache_get_shouldMissOnceTheEntryHasOutlivedTheTTL(t *testing.T) {
	c := newDayCache()
	base, err := time.ParseInLocation("2006-01-02T15:04:05", "2026-08-06T09:00:00", time.Local)
	if err != nil {
		t.Fatal(err)
	}
	now := base
	c.nowFn = func() time.Time { return now }

	c.put("2026-08-05", []byte(`{"window":"2026-08-05"}`))
	now = base.Add(dayCacheTTL - time.Second)
	if _, ok := c.get("2026-08-05"); !ok {
		t.Fatal("an entry inside the TTL should still hit")
	}
	now = base.Add(dayCacheTTL + time.Second)
	if _, ok := c.get("2026-08-05"); ok {
		t.Fatal("an entry past the TTL should miss")
	}
}

func TestDayCache_put_shouldEvictTheOldestEntryWhenFull(t *testing.T) {
	c := newDayCache()
	base, err := time.ParseInLocation("2006-01-02T15:04:05", "2026-08-06T09:00:00", time.Local)
	if err != nil {
		t.Fatal(err)
	}
	now := base
	c.nowFn = func() time.Time { return now }
	c.max = 3

	// distinct storedAt stamps so "oldest" is unambiguous
	for i, day := range []string{"2026-01-01", "2026-01-02", "2026-01-03"} {
		now = base.Add(time.Duration(i) * time.Second)
		c.put(day, []byte(day))
	}
	now = base.Add(10 * time.Second)
	c.put("2026-01-04", []byte("2026-01-04"))

	if len(c.entries) != 3 {
		t.Fatalf("cache should stay at its cap of 3, got %d", len(c.entries))
	}
	if _, ok := c.get("2026-01-01"); ok {
		t.Fatal("the oldest entry should have been evicted")
	}
	for _, day := range []string{"2026-01-02", "2026-01-03", "2026-01-04"} {
		if _, ok := c.get(day); !ok {
			t.Fatalf("%s should have been retained", day)
		}
	}
}
