package flagagent

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/flags"
)

func TestLimitShouldCapConcurrencyWhenFlagsArriveInABurst(t *testing.T) {
	var inFlight, peak int64
	release := make(chan struct{})
	bounded := Limit(investigatorFunc(func(ctx context.Context, _ flags.Record) (flags.Verdict, error) {
		now := atomic.AddInt64(&inFlight, 1)
		for {
			was := atomic.LoadInt64(&peak)
			if now <= was || atomic.CompareAndSwapInt64(&peak, was, now) {
				break
			}
		}
		<-release
		atomic.AddInt64(&inFlight, -1)
		return flags.Verdict{Verdict: "unknown", Confidence: "low", Action: flags.Action{Type: flags.ActionNone}}, nil
	}), 2)

	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = bounded.Investigate(context.Background(), flags.Record{})
		}()
	}
	// Give the goroutines time to pile up against the cap before releasing them.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := atomic.LoadInt64(&peak); got > 2 {
		t.Errorf("peak concurrency = %d, want at most 2", got)
	}
}

func TestLimitShouldTreatNonPositiveAsOneWhenCallerPassesZero(t *testing.T) {
	// Zero must not mean "unbounded" — a caller passing a limit never meant an
	// unbounded fleet of agents.
	if cap(Limit(investigatorFunc(nil), 0).slots) != 1 {
		t.Error("Limit(0) should allow one investigation, not none and not all")
	}
}

func TestLimitShouldGiveUpWhenContextExpiresWaitingForASlot(t *testing.T) {
	blocked := make(chan struct{})
	defer close(blocked)
	bounded := Limit(investigatorFunc(func(ctx context.Context, _ flags.Record) (flags.Verdict, error) {
		<-blocked
		return flags.Verdict{}, nil
	}), 1)

	go func() { _, _ = bounded.Investigate(context.Background(), flags.Record{}) }()
	time.Sleep(20 * time.Millisecond) // let the first claim the only slot

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := bounded.Investigate(ctx, flags.Record{}); err == nil {
		t.Fatal("a queued investigation should fail when its deadline passes, not block forever")
	}
}

type investigatorFunc func(context.Context, flags.Record) (flags.Verdict, error)

func (f investigatorFunc) Investigate(ctx context.Context, r flags.Record) (flags.Verdict, error) {
	return f(ctx, r)
}
