package flagagent

import (
	"context"

	"github.com/tjmisko/switchboard-dashboard/internal/flags"
)

// investigator is the method set Bounded wraps. It is declared here rather than
// imported so this package does not depend on its caller; Go's structural
// interfaces make the wrapper satisfy the caller's own Investigator anyway.
type investigator interface {
	Investigate(context.Context, flags.Record) (flags.Verdict, error)
}

// Bounded caps how many investigations run at once.
//
// Flags arrive in bursts — an operator who notices one bad lane usually notices
// three — and each investigation is a whole Claude Code process reading a
// multi-megabyte log. Without a cap, one irritated minute of clicking would
// launch a dozen of them at once.
//
// Waiting for a slot happens INSIDE the investigation's own timeout, so a
// queued flag can time out without ever having run. That is the right failure:
// the flag stays on the lane, records that the investigation did not happen, and
// can be re-filed. Blocking a caller indefinitely to guarantee every flag its
// turn would be worse.
type Bounded struct {
	inner investigator
	slots chan struct{}
}

// Limit wraps inner so at most n investigations run concurrently. n < 1 is
// treated as 1 rather than as "unbounded", because an unbounded fleet of agents
// is never what a caller passing a limit meant.
func Limit(inner investigator, n int) *Bounded {
	if n < 1 {
		n = 1
	}
	return &Bounded{inner: inner, slots: make(chan struct{}, n)}
}

// Investigate waits for a slot, then delegates.
func (b *Bounded) Investigate(ctx context.Context, record flags.Record) (flags.Verdict, error) {
	select {
	case b.slots <- struct{}{}:
	case <-ctx.Done():
		return flags.Verdict{}, ctx.Err()
	}
	defer func() { <-b.slots }()
	return b.inner.Investigate(ctx, record)
}
