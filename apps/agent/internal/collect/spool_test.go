package collect

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
// events survive. This is "restarting ccx-agent loses no spooled events".
func TestReopen_ResumesSeq_AndKeepsUnacked(t *testing.T) {
	dir := t.TempDir()

	s1 := openTestSpool(t, dir)
	if _, err := s1.Append([]byte("first")); err != nil {
		t.Fatal(err)
	}
	if _, err := s1.Append([]byte("second")); err != nil {
		t.Fatal(err)
	}
	// Ack only the first — "second" is still pending when ccx-agent dies.
	e, _ := s1.Oldest()
	if err := s1.Ack(e); err != nil {
		t.Fatal(err)
	}

	// Reopen (= ccx-agent restart). "second" must still be there.
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

	// Simulate hooks having dropped raw payloads while ccx-agent was down.
	for _, p := range []string{"one", "two", "three"} {
		if err := writeIncoming(s.IncomingDir(), newUUIDv7(), []byte(p)); err != nil {
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
	for _, durable := range []bool{true, false} {
		dir := t.TempDir()
		if err := atomicWrite(filepath.Join(dir, "0000.pb"), []byte("complete"), durable); err != nil {
			t.Fatal(err)
		}
		ents, _ := os.ReadDir(dir)
		if len(ents) != 1 || ents[0].Name() != "0000.pb" {
			t.Fatalf("durable=%v: want only 0000.pb, got %v", durable, ents)
		}
		b, _ := os.ReadFile(filepath.Join(dir, "0000.pb"))
		if string(b) != "complete" {
			t.Errorf("durable=%v: real-named file must be complete, got %q", durable, b)
		}
	}
}

// Only a .raw that is not a temp file is an event (#186): the CLI's agent status
// counts the same set, so what it reports pending is what the next start sends.
func TestIncoming_OnlyRawFilesAreEvents(t *testing.T) {
	s := openTestSpool(t, t.TempDir())
	for name, body := range map[string]string{
		"01a050e6-8722-7c8a-9041-f38193f5a46f.raw": "event",
		".tmp-123.raw":   "half",
		"ccx-agent.lock": "",
		"stray.pb":       "x",
	} {
		if err := os.WriteFile(filepath.Join(s.IncomingDir(), name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := s.PendingIncoming(); err != nil || n != 1 {
		t.Fatalf("PendingIncoming = %d, %v; want 1", n, err)
	}
	if n, err := s.DrainIncoming(); err != nil || n != 1 {
		t.Fatalf("DrainIncoming = %d, %v; want 1", n, err)
	}
	// what was not taken is named, so it can be logged rather than ignored forever
	if err := os.Mkdir(filepath.Join(s.IncomingDir(), "sub.raw"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got, err := s.OtherIncoming(); err != nil || strings.Join(got, ",") != "ccx-agent.lock,stray.pb,sub.raw" {
		t.Errorf("OtherIncoming = %v, %v", got, err)
	}
}

// A temp file the hook left in incoming/ after its time budget is often a whole
// event: a settled one with complete JSON is taken in, an empty or partial one is
// removed, and one still young (maybe being written) is left alone (#218).
func TestOpenSpool_RecoversCompleteIncomingTemps(t *testing.T) {
	dir := t.TempDir()
	incoming := filepath.Join(dir, "incoming")
	if err := os.MkdirAll(incoming, 0o700); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Minute)
	const id = "01a050e6-8722-7c8a-9041-f38193f5a46f"
	const doneID = "01a050e6-8722-7c8a-9041-f38193f5a470"
	if err := os.WriteFile(filepath.Join(incoming, doneID+".raw"), []byte(`{"done":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		".tmp-" + id + ".raw-111":     `{"hook_event_name":"Stop"}`,
		".tmp-" + doneID + ".raw-222": `{"done":"again"}`,
		".tmp-2":                      "",
		".tmp-3":                      `{"hook_event_na`,
		".tmp-4":                      `{"young":true}`,
		".tmp-5":                      `{"old_style":true}`,
	} {
		p := filepath.Join(incoming, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if name != ".tmp-4" {
			if err := os.Chtimes(p, old, old); err != nil {
				t.Fatal(err)
			}
		}
	}
	s := openTestSpool(t, dir)
	if left, _ := filepath.Glob(filepath.Join(incoming, ".tmp-*")); len(left) != 6 {
		t.Fatalf("OpenSpool touched incoming/ temps before the lock: %d left, want 6", len(left))
	}
	// recovered: the id-named temp, the old-style one, and the one whose name is
	// taken (under a minted id, not overwriting); dropped: the empty and the partial
	if r, d, y := s.RecoverIncomingTemps(time.Now()); r != 3 || d != 2 || y != 1 {
		t.Fatalf("recovered %d dropped %d young %d, want 3, 2 and 1", r, d, y)
	}
	for _, gone := range []string{".tmp-2", ".tmp-3"} {
		if _, err := os.Stat(filepath.Join(incoming, gone)); !os.IsNotExist(err) {
			t.Errorf("%s was counted as dropped but is still there: %v", gone, err)
		}
	}
	if b, err := os.ReadFile(filepath.Join(incoming, doneID+".raw")); err != nil || string(b) != `{"done":true}` {
		t.Errorf("the existing .raw was touched: %q %v", b, err)
	}
	if b, err := os.ReadFile(filepath.Join(incoming, "recovered.tmp-"+doneID+".raw-222.raw")); err != nil || string(b) != `{"done":"again"}` {
		t.Errorf("the temp whose name was taken is not under a name of its own: %q %v", b, err)
	}
	if n, err := s.DrainIncoming(); err != nil || n != 4 {
		t.Fatalf("DrainIncoming = %d, %v; want the three recovered events and the existing one", n, err)
	}
	// a temp named the way atomicWrite names it is recovered under its event id
	tmp, err := os.CreateTemp(incoming, tempPattern(filepath.Join(incoming, "01a050e6-8722-7c8a-9041-f38193f5a471.raw")))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = tmp.WriteString(`{"via":"atomicWrite"}`)
	tmp.Close()
	if err := os.Chtimes(tmp.Name(), old, old); err != nil {
		t.Fatal(err)
	}
	if r, d, _ := recoverIncomingTemps(incoming, time.Now()); r != 1 || d != 0 {
		t.Fatalf("recovered %d of the atomicWrite-named temp", r)
	}
	if _, err := os.Stat(filepath.Join(incoming, "01a050e6-8722-7c8a-9041-f38193f5a471.raw")); err != nil {
		t.Errorf("the atomicWrite-named temp was not recovered under its id: %v", err)
	}

	ids := drainAll(t, s)
	found := false
	for _, got := range ids {
		found = found || got == id
	}
	if !found {
		t.Errorf("drained ids %v, want the hook's id %s kept", ids, id)
	}
	if _, err := os.Stat(filepath.Join(incoming, ".tmp-4")); err != nil {
		t.Errorf("the young temp file was touched: %v", err)
	}
}

// The hook's fallback write names its temp after the event, which is what lets a
// temp it could not rename be recovered under the same id (#218).
func TestWriteIncoming_TempNameCarriesTheEvent(t *testing.T) {
	var patterns []string
	createTemp = func(dir, pattern string) (*os.File, error) {
		patterns = append(patterns, pattern)
		return os.CreateTemp(dir, pattern)
	}
	t.Cleanup(func() { createTemp = os.CreateTemp })
	const id = "01a050e6-8722-7c8a-9041-f38193f5a46f"
	if err := writeIncoming(t.TempDir(), id, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if len(patterns) != 1 || patterns[0] != ".tmp-"+id+".raw-*" {
		t.Errorf("temp patterns %q, want the event's name in it", patterns)
	}
}
