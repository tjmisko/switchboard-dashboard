package main

import (
	"testing"

	"github.com/tjmisko/switchboard-dashboard/internal/flags"
)

func TestRecoverShouldSettleFlagsLeftMidInvestigationByARestart(t *testing.T) {
	// An investigation lives in a goroutine, so a restart takes it with it while
	// the record still says "investigating". Without recovery nothing ever moves
	// that record again — and inFlight() makes a re-flag a no-op, so the one
	// button that looks like it should help does nothing.
	srv, _ := ghostServer(t)
	for _, status := range []flags.Status{flags.StatusPending, flags.StatusInvestigating} {
		record := flags.Record{
			SessionID: ghostSession + string(status),
			LaneStart: ghostLaneStart,
			Status:    status,
			Action:    flags.Action{Type: flags.ActionNone},
		}
		if err := srv.Flags.Save(record); err != nil {
			t.Fatalf("Save: %v", err)
		}
	}

	srv.RecoverInterrupted()

	records, err := srv.Flags.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("store holds %d records, want 2", len(records))
	}
	for key, record := range records {
		if record.Status != flags.StatusFailed {
			t.Errorf("%s: status = %q, want failed", key, record.Status)
		}
		if record.Agent == nil || record.Agent.Error == "" {
			t.Errorf("%s: no reason recorded", key)
		}
		// failed is the status whose menu offers "Investigate again", so the
		// operator gets the decision back rather than a stuck flag.
		if inFlight(record.Status) {
			t.Errorf("%s: still absorbs a re-flag", key)
		}
	}
}

func TestRecoverShouldLeaveSettledFlagsAloneWhenRestarting(t *testing.T) {
	srv, _ := ghostServer(t)
	settled := map[flags.Status]flags.Action{
		flags.StatusApplied:       {Type: flags.ActionSuppress},
		flags.StatusPendingReview: {Type: flags.ActionSuppress},
		flags.StatusReverted:      {Type: flags.ActionSuppress},
		flags.StatusFailed:        {Type: flags.ActionNone},
	}
	for status, action := range settled {
		record := flags.Record{
			SessionID: ghostSession + string(status),
			LaneStart: ghostLaneStart,
			Status:    status,
			Action:    action,
			Verdict:   "ghost-lane",
		}
		if err := srv.Flags.Save(record); err != nil {
			t.Fatalf("Save: %v", err)
		}
	}

	srv.RecoverInterrupted()

	records, err := srv.Flags.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, record := range records {
		want := record.SessionID[len(ghostSession):]
		if string(record.Status) != want {
			t.Errorf("a settled %q record was rewritten to %q", want, record.Status)
		}
		if record.Verdict != "ghost-lane" {
			t.Errorf("%s: verdict was lost", record.Status)
		}
	}
}

func TestRecoverShouldDoNothingWhenStoreIsDisabled(t *testing.T) {
	srv := &Server{Flags: flags.NewStore("")}
	srv.RecoverInterrupted() // must not panic or error
}

func TestRecoveredFlagShouldStopSuppressingItsLaneWhenRestartInterrupted(t *testing.T) {
	// A flag that was mid-investigation had no overlay yet, and must not acquire
	// one by being recovered.
	srv, _ := ghostServer(t)
	record := flags.Record{
		SessionID: ghostSession,
		LaneStart: ghostLaneStart,
		Status:    flags.StatusInvestigating,
		Action:    flags.Action{Type: flags.ActionNone},
	}
	if err := srv.Flags.Save(record); err != nil {
		t.Fatalf("Save: %v", err)
	}
	srv.RecoverInterrupted()

	_, parsed := getTimeline(t, srv)
	if got := len(laneStarts(t, parsed)); got != 2 {
		t.Errorf("lanes = %d after recovery, want both still drawn", got)
	}
}
