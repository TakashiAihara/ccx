package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

func testOrigin() *ccxv1.Origin {
	return &ccxv1.Origin{Machine: "test-host", User: "tester"}
}

// deterministic ids/time so tests assert exact values.
func rigged(s *Spool) *Spool {
	var i int
	s.newID = func() string { i++; return fmt.Sprintf("id-%03d", i) }
	var t int64
	s.now = func() time.Time { t++; return time.Unix(t, 0).UTC() }
	return s
}

func openTestSpool(t *testing.T, dir string) *Spool {
	t.Helper()
	s, err := OpenSpool(dir, testOrigin())
	if err != nil {
		t.Fatal(err)
	}
	return rigged(s)
}

func TestAppendThenOldest_FIFO(t *testing.T) {
	s := openTestSpool(t, t.TempDir())

	for _, p := range []string{"a", "b", "c"} {
		if _, err := s.Append([]byte(p)); err != nil {
			t.Fatal(err)
		}
	}

	// Oldest returns front of queue; Ack removes it; repeat drains in order.
	for _, want := range []string{"a", "b", "c"} {
		e, err := s.Oldest()
		if err != nil {
			t.Fatal(err)
		}
		if got := string(e.Event.GetPayload()); got != want {
			t.Fatalf("FIFO order: want %q, got %q", want, got)
		}
		if err := s.Ack(e); err != nil {
			t.Fatal(err)
		}
	}

	if e, _ := s.Oldest(); e != nil {
		t.Errorf("queue should be empty, got %q", e.Event.GetPayload())
	}
}

func TestEnvelope_IsAssignedHere(t *testing.T) {
	s := openTestSpool(t, t.TempDir())
	ev, err := s.Append([]byte(`{"hook":"Stop"}`))
	if err != nil {
		t.Fatal(err)
	}
	if ev.GetEventId() != "id-001" {
		t.Errorf("event_id: want id-001, got %q", ev.GetEventId())
	}
	if ev.GetSeq() != 1 {
		t.Errorf("seq: want 1, got %d", ev.GetSeq())
	}
	if ev.GetProducer() != ccxv1.Producer_PRODUCER_CLAUDE_CODE_HOOK {
		t.Errorf("producer should be the hook producer, got %v", ev.GetProducer())
	}
	if ev.GetOrigin().GetMachine() != "test-host" {
		t.Errorf("origin not stamped: %v", ev.GetOrigin())
	}
}

// The core durability claim: seq keeps climbing across a reopen, and un-acked
// events survive. This is "restarting ccxd loses no spooled events".
func TestReopen_ResumesSeq_AndKeepsUnacked(t *testing.T) {
	dir := t.TempDir()

	s1 := openTestSpool(t, dir)
	if _, err := s1.Append([]byte("first")); err != nil {
		t.Fatal(err)
	}
	if _, err := s1.Append([]byte("second")); err != nil {
		t.Fatal(err)
	}
	// Ack only the first — "second" is still pending when ccxd dies.
	e, _ := s1.Oldest()
	if err := s1.Ack(e); err != nil {
		t.Fatal(err)
	}

	// Reopen (= ccxd restart). "second" must still be there.
	s2 := openTestSpool(t, dir)
	pending, err := s2.Pending()
	if err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatalf("un-acked event should survive restart: pending=%d", pending)
	}
	survivor, _ := s2.Oldest()
	if got := string(survivor.Event.GetPayload()); got != "second" {
		t.Fatalf("wrong survivor: %q", got)
	}
	// seq must not reuse 2 (which "second" holds) — the next append is 3.
	ev, err := s2.Append([]byte("third"))
	if err != nil {
		t.Fatal(err)
	}
	if ev.GetSeq() != 3 {
		t.Errorf("seq should resume past on-disk max: want 3, got %d", ev.GetSeq())
	}
}

// event_id is stored in the file, so a re-read after "restart" yields the SAME
// id — which is what makes a post-crash re-send a dedupable duplicate, not a
// new event. Losing this property silently breaks at-least-once.
func TestEventID_StableAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	s1 := openTestSpool(t, dir)
	ev, _ := s1.Append([]byte("x"))
	originalID := ev.GetEventId()

	s2, err := OpenSpool(dir, testOrigin()) // fresh instance, no rigging
	if err != nil {
		t.Fatal(err)
	}
	reread, _ := s2.Oldest()
	if reread.Event.GetEventId() != originalID {
		t.Errorf("event_id must be stable across restart: was %q, reread %q",
			originalID, reread.Event.GetEventId())
	}
}

func TestDrainIncoming_MovesRawIntoQueueInOrder(t *testing.T) {
	dir := t.TempDir()
	s := openTestSpool(t, dir)

	// Simulate hooks having dropped raw payloads while ccxd was down.
	for _, p := range []string{"one", "two", "three"} {
		if err := writeIncoming(s.IncomingDir(), []byte(p)); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond) // ensure distinct UUIDv7 timestamps
	}

	n, err := s.DrainIncoming()
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("drained %d, want 3", n)
	}

	// incoming/ is now empty; the three are in the main queue, in order.
	for _, want := range []string{"one", "two", "three"} {
		e, err := s.Oldest()
		if err != nil || e == nil {
			t.Fatalf("expected %q, got nil (err %v)", want, err)
		}
		if got := string(e.Event.GetPayload()); got != want {
			t.Fatalf("drain order: want %q, got %q", want, got)
		}
		if err := s.Ack(e); err != nil {
			t.Fatal(err)
		}
	}

	left, _ := os.ReadDir(s.IncomingDir())
	if len(left) != 0 {
		t.Errorf("incoming should be empty after drain, has %d", len(left))
	}
}

// A crash mid-write must never leave a half-event under a real name. We can at
// least assert the invariant that only complete files carry the .pb name (temps
// are .tmp-*), so Oldest never reads a partial.
func TestAtomicWrite_LeavesNoPartialUnderRealName(t *testing.T) {
	dir := t.TempDir()
	if err := atomicWrite(filepath.Join(dir, "0000.pb"), []byte("complete")); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if e.Name() == "0000.pb" {
			b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
			if string(b) != "complete" {
				t.Errorf("real-named file must be complete, got %q", b)
			}
			return
		}
	}
	t.Error("expected the renamed file to exist")
}
